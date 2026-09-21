import { loadPiSdk } from './pi-sdk-loader.mjs';
import { parseJsonc, redactSecrets, mergeSecretPlaceholders, validateAndNormalizeModelsConfig, validProviderId, VALID_THINKING_LEVELS } from './model-config.mjs';
import { fault } from '../../shared/errors.js';
import { createWorkspaceSettings } from './workspace-resources.mjs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const TEST_TIMEOUT_MS = 20_000;

export class PiAdmin {
  constructor({ agentDir, cwd, piRuntime, env = process.env, log = console }) {
    this.agentDir = agentDir;
    this.cwd = cwd;
    this.piRuntime = piRuntime;
    this.env = env;
    this.log = log;
    this.authPath = path.join(agentDir, "auth.json");
    this.modelsPath = path.join(agentDir, "models.json");
    this.modelsStorePath = path.join(agentDir, "models-store.json");
    this.maintenanceTail = Promise.resolve();
    this.maintenanceActive = false;
    this.loginInputs = new Map();
    this.activeLogins = new Map();
  }

  async createRuntime(extra = {}) {
    const { ModelRuntime } = await loadPiSdk(this.env);
    return ModelRuntime.create({
      authPath: this.authPath,
      modelsPath: this.modelsPath,
      modelsStorePath: this.modelsStorePath,
      allowModelNetwork: false,
      refreshOnCreate: true,
      ...extra,
    });
  }

  async providers() {
    const runtime = await this.createRuntime();
    const credentials = new Map();
    try {
      for (const item of await runtime.listCredentials()) credentials.set(item.providerId, item.type);
    } catch {}
    const models = runtime.getModels();
    const oauthProviders = [];
    const apiKeyProviders = [];
    for (const provider of runtime.getProviders()) {
      const credentialType = credentials.get(provider.id);
      const status = runtime.getProviderAuthStatus(provider.id);
      const modelCount = models.filter((model) => model.provider === provider.id).length;
      if (provider.auth?.oauth) {
        oauthProviders.push({
          id: provider.id,
          name: provider.id === "openai-codex" ? "ChatGPT Plus/Pro" : provider.id === "github-copilot" ? "GitHub Copilot" : provider.auth.oauth.name || provider.name,
          loggedIn: credentialType === "oauth",
          supportsApiKey: Boolean(provider.auth?.apiKey?.login),
          modelCount,
        });
      }
      if (provider.auth?.apiKey?.login && !(status.source === "models_json_key" || status.source === "models_json_command")) {
        apiKeyProviders.push({
          id: provider.id,
          name: provider.name,
          configured: status.configured && credentialType !== "oauth",
          source: status.configured && credentialType !== "oauth" ? status.source || null : null,
          supportsOAuth: Boolean(provider.auth?.oauth),
          modelCount,
        });
      }
    }
    return { oauthProviders, apiKeyProviders };
  }

  assertMaintenanceAvailable() {
    if (this.maintenanceActive) throw fault(409, "正在进行其他登录或模型配置操作");
    if (this.piRuntime?.state === "busy" || this.piRuntime?.busyReasons?.size || this.piRuntime?.pending?.size) {
      throw fault(409, "宝蛋正在处理任务，请停止或等待任务完成后再修改登录和模型配置");
    }
  }

  cancelLoginInputs(providerId, error) {
    for (const [token, pending] of this.loginInputs) {
      if (providerId && pending.providerId !== providerId) continue;
      this.loginInputs.delete(token);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  async cancelOAuthLogins(message = "已切换到其他供应商登录") {
    const hadActiveLogin = Boolean(this.activeLogins.size);
    if (!hadActiveLogin && !this.maintenanceActive) return false;
    const error = new Error(message);
    for (const abort of this.activeLogins.values()) abort.abort(error);
    this.cancelLoginInputs(null, error);
    await this.maintenanceTail.catch(() => {});
    return hadActiveLogin;
  }

  async withMaintenance(operation) {
    this.assertMaintenanceAvailable();
    const run = async () => {
      this.maintenanceActive = true;
      const sessionPath = this.piRuntime?.activeSessionPath || null;
      const shouldRestart = Boolean(this.piRuntime?.running || sessionPath);
      let result;
      let operationError;
      try {
        if (this.piRuntime?.running) await this.piRuntime.stop("maintenance");
        result = await operation();
      } catch (error) {
        operationError = error;
      }
      try {
        if (shouldRestart && !this.piRuntime?.closed) await this.piRuntime.ensureStarted(sessionPath);
      } catch (error) {
        this.log.error("Windows Pi恢复失败：", error.message);
        if (!operationError) operationError = fault(500, `配置已更新，但 Windows Pi恢复失败：${error.message}`);
      } finally {
        this.maintenanceActive = false;
      }
      if (operationError) throw operationError;
      return result;
    };
    const result = this.maintenanceTail.then(run, run);
    this.maintenanceTail = result.catch(() => {});
    return result;
  }

  async loginOAuth(providerId, { signal, emit }) {
    if (!validProviderId(providerId)) throw fault(400, "供应商名称无效");
    return this.withMaintenance(async () => {
      const runtime = await this.createRuntime();
      const provider = runtime.getProvider(providerId);
      if (!provider?.auth?.oauth) throw fault(400, `供应商不支持 OAuth登录：${providerId}`);
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(new Error("登录超时")), AUTH_TIMEOUT_MS);
      timeout.unref?.();
      const onAbort = () => {
        const error = new Error("登录已取消");
        abort.abort(error);
        this.cancelLoginInputs(providerId, error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.activeLogins.set(providerId, abort);
      let pendingManual = null;
      const createInput = (prompt) => {
        const token = `${providerId}-${Date.now()}-${crypto.randomUUID()}`;
        let timer;
        const promise = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("登录输入已超时")), AUTH_TIMEOUT_MS);
          timer.unref?.();
          this.loginInputs.set(token, { providerId, resolve, reject, timer });
        }).finally(() => {
          clearTimeout(timer);
          this.loginInputs.delete(token);
          if (pendingManual?.token === token) pendingManual = null;
        });
        return { token, promise, prompt };
      };
      const getManual = (prompt = { type: "manual_code", message: "粘贴授权结果" }) => {
        if (!pendingManual) pendingManual = createInput(prompt);
        return pendingManual;
      };
      try {
        await runtime.login(providerId, "oauth", {
          signal: abort.signal,
          prompt: async (prompt) => {
            const request = prompt.type === "manual_code" ? getManual(prompt) : createInput(prompt);
            emit({ type: "input", token: request.token, promptType: prompt.type, message: prompt.message || "请输入登录信息", placeholder: prompt.placeholder || null, options: prompt.options || null });
            return request.promise;
          },
          notify: (event) => {
            if (event.type === "auth_url") {
              const request = getManual();
              emit({ type: "auth", url: event.url, instructions: event.instructions || null, token: request.token });
            } else if (event.type === "device_code") {
              emit({ type: "device_code", userCode: event.userCode, verificationUri: event.verificationUri, intervalSeconds: event.intervalSeconds || null, expiresInSeconds: event.expiresInSeconds || null });
            } else emit({ type: "progress", message: event.message || "正在登录" });
          },
        });
        emit({ type: "success", provider: providerId });
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (this.activeLogins.get(providerId) === abort) this.activeLogins.delete(providerId);
        this.cancelLoginInputs(providerId, new Error("登录已结束"));
      }
    });
  }

  submitLoginInput(providerId, token, value) {
    const pending = this.loginInputs.get(token);
    if (!pending) throw fault(404, "登录请求已失效，请重新登录");
    if (pending.providerId !== providerId || !token.startsWith(`${providerId}-`)) throw fault(400, "登录令牌与供应商不匹配");
    if (typeof value !== "string" || !value.trim()) throw fault(400, "登录输入不能为空");
    this.loginInputs.delete(token);
    clearTimeout(pending.timer);
    pending.resolve(value.trim());
  }

  async logout(providerId, expectedType = "oauth") {
    if (!validProviderId(providerId)) throw fault(400, "供应商名称无效");
    return this.withMaintenance(async () => {
      const credentials = await readCredentialFile(this.authPath);
      const credential = credentials[providerId];
      if (!credential) return { removed: false };
      if (credential.type !== expectedType) throw fault(409, `${providerId} 当前使用的不是${expectedType === "oauth" ? "OAuth" : "API Key"}登录`);
      delete credentials[providerId];
      await backupAndAtomicJson(this.authPath, credentials, "auth");
      return { removed: true };
    });
  }

  async saveApiKey(providerId, apiKey) {
    if (!validProviderId(providerId)) throw fault(400, "供应商名称无效");
    if (typeof apiKey !== "string" || !apiKey.trim()) throw fault(400, "API Key不能为空");
    return this.withMaintenance(async () => {
      const runtime = await this.createRuntime();
      const login = runtime.getProvider(providerId)?.auth?.apiKey?.login;
      if (!login) throw fault(400, `供应商不支持 API Key登录：${providerId}`);
      let submitted = false;
      const abort = AbortSignal.timeout(30_000);
      const credential = await login({
        signal: abort,
        notify: () => {},
        prompt: async (prompt) => {
          if (prompt.type === "select") {
            const option = prompt.options?.find((item) => item.id === "api-key" || item.id === "bearer-token");
            if (option) return option.id;
          }
          if (prompt.type === "secret" && !submitted) { submitted = true; return apiKey.trim(); }
          throw fault(400, `${providerId} 需要额外的交互式认证信息`);
        },
      });
      const credentials = await readCredentialFile(this.authPath);
      if (credentials[providerId]?.type === "oauth") throw fault(409, `${providerId} 当前使用 OAuth登录，请先退出 OAuth`);
      credentials[providerId] = credential;
      await backupAndAtomicJson(this.authPath, credentials, "auth");
      return { saved: true };
    });
  }

  async readModelsConfig() {
    const raw = await readJsoncFile(this.modelsPath, { providers: {} });
    return redactSecrets(raw);
  }

  async saveModelsConfig(incoming) {
    return this.withMaintenance(async () => {
      const current = await readJsoncFile(this.modelsPath, { providers: {} });
      const merged = mergeSecretPlaceholders(incoming, current);
      const normalized = validateAndNormalizeModelsConfig(merged);
      await backupAndAtomicJson(this.modelsPath, normalized, "models");
      return { saved: true };
    });
  }

  async preferences() {
    const { SettingsManager } = await loadPiSdk(this.env);
    const settings = createWorkspaceSettings({ SettingsManager }, this.cwd, this.agentDir);
    return { enabledModels: settings.getEnabledModels() || [] };
  }

  async catalog() {
    const [runtime, sdk] = await Promise.all([this.createRuntime(), loadPiSdk(this.env)]);
    let available;
    try { available = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(15_000) }); }
    catch { available = runtime.getAvailableSnapshot(); }
    const settings = createWorkspaceSettings(sdk, this.cwd, this.agentDir);
    const models = [...available].map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name || model.id,
      reasoning: Boolean(model.reasoning),
      input: model.input || ["text"],
      thinkingLevelMap: model.thinkingLevelMap || null,
    })).sort((a, b) => `${a.provider}/${a.name}`.localeCompare(`${b.provider}/${b.name}`, undefined, { numeric: true }));
    return {
      models,
      defaultModel: settings.getDefaultProvider() && settings.getDefaultModel() ? { provider: settings.getDefaultProvider(), modelId: settings.getDefaultModel() } : null,
      defaultThinkingLevel: settings.getDefaultThinkingLevel() || "off",
      modelThinkingLevels: settings.getAllModelThinkingLevels(),
      enabledModels: settings.getEnabledModels() || [],
    };
  }

  async savePreferences(body) {
    return this.withMaintenance(async () => {
      const { SettingsManager } = await loadPiSdk(this.env);
      const settings = createWorkspaceSettings({ SettingsManager }, this.cwd, this.agentDir);
      if (body.defaultModel == null) {
        // Pi has no clear pair API; preserve current defaults when omitted.
      } else {
        const provider = String(body.defaultModel.provider || "").trim();
        const modelId = String(body.defaultModel.modelId || "").trim();
        if (!provider || !modelId) throw fault(400, "默认模型无效");
        settings.setDefaultModelAndProvider(provider, modelId);
      }
      if (typeof body.defaultThinkingLevel === "string") {
        if (!VALID_THINKING_LEVELS.has(body.defaultThinkingLevel)) throw fault(400, "默认思考等级无效");
        settings.setDefaultThinkingLevel(body.defaultThinkingLevel);
      }
      if (Array.isArray(body.enabledModels)) settings.setEnabledModels(body.enabledModels.map(String).map((item) => item.trim()).filter(Boolean));
      if (body.modelThinkingLevels && typeof body.modelThinkingLevels === "object") {
        const existing = settings.getAllModelThinkingLevels();
        for (const key of Object.keys(existing)) {
          if (!Object.hasOwn(body.modelThinkingLevels, key)) {
            const split = key.indexOf("/");
            if (split > 0) settings.removeModelThinkingLevel(key.slice(0, split), key.slice(split + 1));
          }
        }
        for (const [key, level] of Object.entries(body.modelThinkingLevels)) {
          const split = key.indexOf("/");
          if (split > 0 && typeof level === "string") {
            if (!VALID_THINKING_LEVELS.has(level)) throw fault(400, `${key} 的思考等级无效`);
            settings.setModelThinkingLevel(key.slice(0, split), key.slice(split + 1), level);
          }
        }
      }
      await settings.flush();
      const errors = settings.drainErrors();
      if (errors.length) throw new Error(errors.map((item) => item.error.message).join("; "));
      return { saved: true };
    });
  }

  async testModel(body) {
    const providerName = String(body.providerName || "").trim();
    if (!validProviderId(providerName) || !body.provider || !body.model) throw fault(400, "模型测试参数无效");
    const current = await readJsoncFile(this.modelsPath, { providers: {} });
    const currentProvider = current.providers?.[providerName] || {};
    const provider = mergeSecretPlaceholders(body.provider, currentProvider);
    const model = body.model;
    if (!String(model.id || "").trim()) throw fault(400, "模型ID不能为空");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "super-baodan-model-test-"));
    const modelsPath = path.join(tempDir, "models.json");
    try {
      await writeFile(modelsPath, JSON.stringify({ providers: { [providerName]: { ...provider, models: [model] } } }, null, 2), "utf8");
      const runtime = await this.createRuntime({ modelsPath, refreshOnCreate: false });
      const loaded = runtime.getModel(providerName, model.id);
      if (!loaded) throw new Error(`未找到模型：${providerName}/${model.id}`);
      const startedAt = Date.now();
      const response = await runtime.completeSimple(loaded, { messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }] }, { maxTokens: 16, maxRetries: 0, timeoutMs: TEST_TIMEOUT_MS, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
      const text = Array.isArray(response.content) ? response.content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
      if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || "模型测试失败");
      return { ok: true, latencyMs: Date.now() - startedAt, responseText: text.slice(0, 300) };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  close() {
    const shutdownError = new Error("工作台已退出");
    for (const abort of this.activeLogins.values()) abort.abort(shutdownError);
    this.cancelLoginInputs(null, shutdownError);
    this.activeLogins.clear();
    for (const [token, pending] of this.loginInputs) {
      pending.reject(new Error("工作台已退出"));
      clearTimeout(pending.timer);
      this.loginInputs.delete(token);
    }
  }
}

async function readJsoncFile(filePath, fallback) {
  try { return parseJsonc(await readFile(filePath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw fault(500, `配置文件解析失败：${path.basename(filePath)}：${error.message}`);
  }
}

async function readCredentialFile(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("根节点必须是对象");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw fault(500, `认证文件解析失败：${error.message}`);
  }
}

export async function backupAndAtomicJson(filePath, value, prefix) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (existsSync(filePath)) await copyFile(filePath, path.join(path.dirname(filePath), `${prefix}-backup-${stamp}.json`));
  const temp = `${filePath}.super-baodan-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, filePath);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

