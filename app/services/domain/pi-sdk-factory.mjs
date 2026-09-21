import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPiSdk, piPackageRoot } from './pi-sdk-loader.mjs';
import { prepareWorkspace, workspaceLayoutPrompt } from './workspace-layout.mjs';
import { createWorkspaceSettings, workspaceResourceOptions, validateWorkspaceSettings } from './workspace-resources.mjs';
import { applicationDataPrompt } from './app-data-context.mjs';

const SHELL_WRAPPER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/shell-wrappers");

export function findSdkEntry(env = process.env) {
  const entry = path.join(piPackageRoot(env), "dist", "index.js");
  return existsSync(entry) ? entry : null;
}

// One process-wide environment, one active Agent. Never chdir the HTTP server.
// Tools/extensions must use their SDK context.cwd; child shells inherit UTF-8.
export function prepareSdkEnvironment(agentDir, env = process.env, platform = process.platform) {
  Object.assign(env, {
    PI_CODING_AGENT_DIR: agentDir, AI_AGENT: "pi", PI_CODING_AGENT: "true",
    PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
  });
  if (platform === "win32") {
    const key = Object.keys(env).find((name) => name.toLowerCase() === "path") || "PATH";
    const parts = (env[key] || "").split(";");
    if (!parts.some((part) => part.toLowerCase() === SHELL_WRAPPER_DIR.toLowerCase())) parts.unshift(SHELL_WRAPPER_DIR);
    env[key] = parts.join(";");
  }
}

export async function createSdkHost({ cwd, agentDir, sessionDir, sessionPath, sessionManager, dataPaths, allowMigration = false, log = console }) {
  const dataPrompt = applicationDataPrompt(dataPaths);
  prepareSdkEnvironment(agentDir);
  const sdk = await loadPiSdk();
  for (const name of ["createAgentSessionRuntime", "createAgentSessionServices", "createAgentSessionFromServices"]) {
    if (typeof sdk[name] !== "function") throw new Error(`Windows Pi SDK缺少 ${name}，需要兼容的 Pi 0.84.4 或以上版本`);
  }
  sdk.initTheme("dark", false);
  // Theme is the only version-specific subpath; extensions use it for labels,
  // but no terminal, stdin takeover or theme watcher is started.
  const { theme } = await import(pathToFileURL(path.join(piPackageRoot(), "dist/modes/interactive/theme/theme.js")).href);
  const createRuntime = async ({ cwd: targetCwd, sessionManager: manager, sessionStartEvent }) => {
    const layout = await prepareWorkspace(targetCwd, { sessionId: manager.getSessionId(), allowMigration });
    const settingsManager = createWorkspaceSettings(sdk, targetCwd, agentDir);
    const services = await sdk.createAgentSessionServices({
      cwd: targetCwd, agentDir, settingsManager,
      resourceLoaderOptions: {
        ...workspaceResourceOptions(layout),
        appendSystemPromptOverride: base => [...base, ...[dataPrompt, workspaceLayoutPrompt(layout)].filter(Boolean)],
      },
      // Same registered-workspace trust policy as the former CLI --approve.
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
    });
    const reloadResources = services.resourceLoader.reload.bind(services.resourceLoader);
    services.resourceLoader.reload = async options => {
      await prepareWorkspace(targetCwd, { sessionId: manager.getSessionId(), allowMigration });
      validateWorkspaceSettings(targetCwd);
      return reloadResources(options);
    };
    const patterns = settingsManager.getEnabledModels() || [];
    const { scopedModels = [], diagnostics = [] } = patterns.length
      ? await sdk.resolveModelScopeWithDiagnostics(patterns, services.modelRuntime)
      : {};
    const result = await sdk.createAgentSessionFromServices({ services, sessionManager: manager, sessionStartEvent, scopedModels });
    for (const item of [...services.diagnostics, ...diagnostics]) log.warn(`[pi-sdk] ${item.message || item}`);
    if (result.modelFallbackMessage) log.warn(`[pi-sdk] ${result.modelFallbackMessage}`);
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const manager = sessionManager || (sessionPath
    ? sdk.SessionManager.open(sessionPath, sessionDir)
    : sdk.SessionManager.create(cwd, sessionDir));
  const host = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: manager });
  return { host, theme };
}

export async function renameSavedSession(file, sessionDir, name) {
  const { SessionManager } = await loadPiSdk();
  SessionManager.open(file, sessionDir).appendSessionInfo(name);
}
