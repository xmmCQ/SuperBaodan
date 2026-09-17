import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadPiSdk, statusError } from "./pi-admin.mjs";
import { transferSkillDirectory } from './skill-transfer.mjs';
import { openSkillDirectory } from './open-skill-directory.mjs';
import { SkillDirectoryCache } from './skill-directory-cache.mjs';

const execFileAsync = promisify(execFile);
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PACKAGE_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*(?:@[A-Za-z0-9][\w.-]*)?$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const ANSI_RE = /\x1B\[[0-9;]*m/g;
const SEARCH_TTL_MS = 5 * 60 * 1000;
const SEARCH_LIMIT = 30;
const CLI_TIMEOUT_MS = 90_000;
const MAX_CLI_OUTPUT = 32_000;
const DISABLE_KEY = "disable-model-invocation";

export function validateSkillName(value) {
  const name = String(value || "").trim();
  if (!SKILL_NAME_RE.test(name) || WINDOWS_RESERVED.test(name) || name === "." || name === "..") {
    throw statusError(400, "Skill名称仅允许字母、数字、点、下划线和连字符，且不能使用Windows保留名");
  }
  return name;
}

export function validateSkillPackage(value) {
  const pkg = String(value || "").trim();
  if (!PACKAGE_RE.test(pkg) || pkg.split(/[\/@]/).some((part) => part.startsWith("-"))) {
    throw statusError(400, "Skill来源格式无效，应为 owner/repo 或 owner/repo@skill");
  }
  return pkg;
}

export function parseSkillMarkdown(content) {
  const text = String(content ?? "");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") throw statusError(400, "SKILL.md必须包含YAML frontmatter");
  const closing = lines.indexOf("---", 1);
  if (closing < 0) throw statusError(400, "SKILL.md的YAML frontmatter未闭合");
  const spans = frontmatterSpans(lines, closing);
  const name = scalarFromSpan(lines, spans.get("name"));
  const description = scalarFromSpan(lines, spans.get("description"));
  if (!name) throw statusError(400, "SKILL.md缺少name");
  if (!description) throw statusError(400, "SKILL.md缺少description");
  return {
    name: validateSkillName(name),
    description,
    body: lines.slice(closing + 1).join(newline).replace(/^\s*\r?\n/, ""),
    newline,
    lines,
    closing,
    spans,
  };
}

export function buildSkillMarkdown({ name, description, body = "", disableModelInvocation = false }) {
  const safeName = validateSkillName(name);
  const safeDescription = normalizeDescription(description);
  const disabled = disableModelInvocation ? `${DISABLE_KEY}: true\n` : "";
  return `---\nname: ${yamlString(safeName)}\ndescription: ${yamlString(safeDescription)}\n${disabled}---\n\n${String(body).replace(/^\s+|\s+$/g, "")}\n`;
}

export function updateStructuredSkillMarkdown(content, { description, body }) {
  const parsed = parseSkillMarkdown(content);
  const lines = [...parsed.lines];
  const descriptionSpan = parsed.spans.get("description");
  const replacement = [`description: ${yamlString(normalizeDescription(description))}`];
  if (!descriptionSpan) throw statusError(400, "SKILL.md缺少description");
  lines.splice(descriptionSpan.start, descriptionSpan.end - descriptionSpan.start, ...replacement);
  const closing = lines.indexOf("---", 1);
  const head = lines.slice(0, closing + 1).join(parsed.newline);
  return `${head}${parsed.newline}${parsed.newline}${String(body ?? "").replace(/^\s+|\s+$/g, "")}${parsed.newline}`;
}

export function setDisableModelInvocation(content, disable) {
  const parsed = parseSkillMarkdown(content);
  const lines = [...parsed.lines];
  const span = parsed.spans.get(DISABLE_KEY);
  if (disable) {
    if (span) lines.splice(span.start, span.end - span.start, `${DISABLE_KEY}: true`);
    else lines.splice(1, 0, `${DISABLE_KEY}: true`);
  } else if (span) {
    lines.splice(span.start, span.end - span.start);
  } else return content;
  return lines.join(parsed.newline);
}

export function readSkillLocks({ homeDir, cwd }) {
  return {
    global: readLockSync(path.join(homeDir, ".agents", ".skill-lock.json")),
    project: readLockSync(path.join(cwd, "skills-lock.json")),
  };
}

export function annotateInstall(skill, locks, scope) {
  if (scope !== "global" && scope !== "project") return null;
  const entry = findLockEntry(locks[scope], skill.name);
  if (!entry || typeof entry.source !== "string" || !entry.source.trim()) return null;
  const sourceType = typeof entry.sourceType === "string" ? entry.sourceType : null;
  const source = normalizeSource(entry.source, sourceType);
  const versionHash = scope === "global" ? entry.skillFolderHash : entry.computedHash;
  const skillPath = typeof entry.skillPath === "string" ? entry.skillPath : null;
  const ref = typeof entry.ref === "string" ? entry.ref : null;
  const comparable = sourceType === "github" && /^[\w.-]+\/[\w.-]+$/.test(source) && skillPath && typeof versionHash === "string" && (scope === "global" || !ref);
  return {
    package: `${source}@${skill.name}`,
    scope,
    source,
    sourceType,
    versionHash: typeof versionHash === "string" ? versionHash : null,
    skillPath,
    ref,
    skillsShUrl: sourceType === "local" ? null : `https://skills.sh/${source}/${encodeURIComponent(skill.name)}`,
    canCheckForUpdates: Boolean(comparable),
  };
}

export function buildSkillCliArgs(action, payload) {
  const scope = normalizeScope(payload.scope);
  if (action === "install") {
    const args = ["skills", "add", validateSkillPackage(payload.package), "-y", "--agent", "pi"];
    if (scope === "global") args.push("-g");
    return args;
  }
  if (action === "update") {
    const install = payload.install;
    if (!install) throw statusError(400, "缺少安装记录");
    const source = validateRepository(install.source);
    const folder = skillFolder(install.skillPath || "");
    const ref = install.ref ? `#${encodeURIComponent(install.ref)}` : "";
    const args = ["skills", "add", `${source}${folder ? `/${folder}` : ""}${ref}`, "--skill", validateSkillName(payload.name), "-y", "--agent", "pi"];
    if (scope === "global") args.push("-g");
    return args;
  }
  if (action === "uninstall") {
    const args = ["skills", "remove", validateSkillName(payload.name), "-y", "--agent", "pi"];
    if (scope === "global") args.push("-g");
    return args;
  }
  throw statusError(400, "未知Skill CLI操作");
}

export class SkillManager {
  constructor({ agentDir, cwd, backupDir, piAdmin, env = process.env, fetchImpl = fetch, execFileImpl = execFileAsync, loadSdk = loadPiSdk, openDirectoryImpl = openSkillDirectory, log = console }) {
    this.agentDir = path.resolve(agentDir);
    this.cwd = path.resolve(cwd);
    this.backupDir = path.resolve(backupDir);
    this.piAdmin = piAdmin;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.execFileImpl = execFileImpl;
    this.loadSdk = loadSdk;
    this.openDirectoryImpl = openDirectoryImpl;
    this.log = log;
    this.searchCache = new Map();
    this.directoryCache = new SkillDirectoryCache();
  }

  get homeDir() { return this.env.USERPROFILE || os.homedir(); }
  get globalRoot() { return path.join(this.agentDir, "skills"); }
  get projectRoot() { return path.join(this.cwd, ".pi", "skills"); }
  get globalLockPath() { return path.join(this.homeDir, ".agents", ".skill-lock.json"); }
  get projectLockPath() { return path.join(this.cwd, "skills-lock.json"); }

  async list() {
    const sequence = this.directoryCache.begin();
    const { DefaultResourceLoader } = await this.loadSdk(this.env);
    if (typeof DefaultResourceLoader !== "function") throw statusError(503, "Windows Pi SDK不支持Skill管理，请更新Pi");
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getSkills();
    const locks = readSkillLocks({ homeDir: this.homeDir, cwd: this.cwd });
    const skills = [];
    for (const skill of loaded.skills || []) skills.push(await this.describeSkill(skill, locks));
    skills.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name, "zh-CN"));
    const cliAvailable = await this.isCliAvailable();
    await this.directoryCache.publish(skills, sequence);
    return {
      skills,
      diagnostics: (loaded.diagnostics || []).map(safeDiagnostic),
      cliAvailable,
    };
  }

  async describeSkill(skill, locks) {
    const filePath = path.resolve(skill.filePath);
    const scope = isInside(filePath, this.projectRoot) ? "project" : isInside(filePath, this.globalRoot) ? "global" : "other";
    const install = annotateInstall(skill, locks, scope);
    const custom = !install && (scope === "global" || scope === "project") && await this.isWritableSkillPath(scope, skill.name, filePath);
    let content = null;
    let body = null;
    let auxiliaryFiles = [];
    if (custom) {
      content = await readFile(filePath, "utf8");
      try { body = parseSkillMarkdown(content).body; } catch {}
      auxiliaryFiles = await listAuxiliaryFiles(path.dirname(filePath));
    }
    return {
      id: createHash("sha256").update(`${scope}\0${filePath}`).digest("hex").slice(0, 20),
      name: skill.name,
      description: skill.description || "",
      filePath,
      scope,
      source: skill.sourceInfo?.source || scope,
      sourceInfo: skill.sourceInfo || null,
      disableModelInvocation: Boolean(skill.disableModelInvocation),
      install,
      writable: custom,
      revision: custom ? createHash('sha256').update(content).digest('hex') : null,
      content,
      body,
      auxiliaryFiles,
    };
  }

  async search(query) {
    const q = String(query || "").trim().slice(0, 100);
    if (!q) throw statusError(400, "请输入搜索内容");
    const cached = this.searchCache.get(q.toLowerCase());
    if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return { results: cached.results };
    const url = `https://skills.sh/api/search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`;
    let response;
    try { response = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } }); }
    catch (error) { throw statusError(502, `skills.sh连接失败：${error.message}`); }
    if (!response.ok) throw statusError(502, `skills.sh搜索失败：HTTP ${response.status}`);
    const data = await response.json();
    const results = (Array.isArray(data.skills) ? data.skills : []).slice(0, SEARCH_LIMIT).map((item) => normalizeSearchResult(item)).filter(Boolean);
    this.searchCache.set(q.toLowerCase(), { at: Date.now(), results });
    return { results };
  }

  install(payload) {
    const pkg = validateSkillPackage(payload.package);
    const scope = normalizeScope(payload.scope);
    return this.mutateWithMaintenance(async () => {
      await this.requireCli();
      const packageSkill = pkg.includes("@") ? pkg.slice(pkg.lastIndexOf("@") + 1) : null;
      const snapshot = await this.backupMutation(`install-${scope}-${safeSegment(pkg)}`, { scope, name: packageSkill, includeRootListing: true });
      try {
        await this.runCli(buildSkillCliArgs("install", { package: pkg, scope }));
        return { installed: true };
      } catch (error) {
        await this.rollback(snapshot).catch((rollbackError) => { error.message += `；自动恢复失败，备份位于 ${snapshot.dir}：${rollbackError.message}`; });
        throw error;
      }
    });
  }

  async checkUpdates(payload = {}) {
    const listed = await this.list();
    const installs = listed.skills.filter((skill) => skill.install && (!payload.package || (skill.install.package === payload.package && skill.scope === payload.scope)));
    return { updates: await Promise.all(installs.map((skill) => this.checkOneUpdate(skill))) };
  }

  update(payload) {
    const scope = normalizeScope(payload.scope);
    const pkg = validateSkillPackage(payload.package);
    return this.mutateWithMaintenance(async () => {
      await this.requireCli();
      const skill = await this.findManagedSkill(pkg, scope);
      const snapshot = await this.backupMutation(`update-${scope}-${skill.name}`, { scope, name: skill.name });
      try {
        await this.runCli(buildSkillCliArgs("update", { scope, name: skill.name, install: skill.install }));
        return { updated: true };
      } catch (error) {
        await this.rollback(snapshot).catch((rollbackError) => { error.message += `；自动恢复失败，备份位于 ${snapshot.dir}：${rollbackError.message}`; });
        throw error;
      }
    });
  }

  uninstall(payload) {
    const scope = normalizeScope(payload.scope);
    const name = validateSkillName(payload.name);
    const pkg = validateSkillPackage(payload.package);
    return this.mutateWithMaintenance(async () => {
      await this.requireCli();
      const skill = await this.findManagedSkill(pkg, scope, name);
      const snapshot = await this.backupMutation(`uninstall-${scope}-${name}`, { scope, name });
      try {
        await this.runCli(buildSkillCliArgs("uninstall", { scope, name }));
        return { uninstalled: true };
      } catch (error) {
        await this.rollback(snapshot).catch((rollbackError) => { error.message += `；自动恢复失败，备份位于 ${snapshot.dir}：${rollbackError.message}`; });
        throw error;
      }
    });
  }

  setInvocation(payload) {
    const scope = normalizeScope(payload.scope);
    const name = validateSkillName(payload.name);
    if (typeof payload.disableModelInvocation !== "boolean") throw statusError(400, "缺少自动调用设置");
    return this.mutateWithMaintenance(async () => {
      const skill = await this.findSkill(scope, name);
      if (scope === "other") throw statusError(403, "该Skill为只读来源");
      if (skill.install) await this.assertSafeManagedSkill(skill);
      else await this.assertSafeExistingSkill(scope, name, skill.filePath);
      const current = await readFile(skill.filePath, "utf8");
      const updated = setDisableModelInvocation(current, payload.disableModelInvocation);
      if (updated === current) return { unchanged: true };
      await this.backupMutation(`invocation-${scope}-${name}`, { scope, name });
      await atomicWrite(skill.filePath, updated);
      return { saved: true };
    });
  }

  createCustom(payload) {
    const scope = normalizeScope(payload.scope);
    const name = validateSkillName(payload.name);
    const root = this.rootForScope(scope);
    return this.mutateWithMaintenance(async () => {
      await mkdir(root, { recursive: true });
      await this.assertSafeRoot(root);
      const directory = path.join(root, name);
      if (existsSync(directory)) throw statusError(409, `Skill已存在：${name}`);
      const content = payload.mode === "raw"
        ? String(payload.content || "")
        : buildSkillMarkdown({ name, description: payload.description, body: payload.body, disableModelInvocation: false });
      await this.validateRawContent(content, name);
      await mkdir(directory, { recursive: false });
      try { await atomicWrite(path.join(directory, "SKILL.md"), content); }
      catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
      return { created: true };
    });
  }

  updateCustom(payload) {
    const scope = normalizeScope(payload.scope);
    const name = validateSkillName(payload.name);
    return this.mutateWithMaintenance(async () => {
      const filePath = path.join(this.rootForScope(scope), name, "SKILL.md");
      await this.assertSafeExistingSkill(scope, name, filePath);
      const locks = readSkillLocks({ homeDir: this.homeDir, cwd: this.cwd });
      if (annotateInstall({ name }, locks, scope)) throw statusError(409, "skills.sh管理的Skill不能直接编辑，请使用更新功能");
      const current = await readFile(filePath, "utf8");
      const updated = payload.mode === "raw" ? String(payload.content || "") : updateStructuredSkillMarkdown(current, payload);
      await this.validateRawContent(updated, name);
      if (updated === current) return { unchanged: true };
      await this.backupMutation(`edit-${scope}-${name}`, { scope, name });
      await atomicWrite(filePath, updated);
      return { saved: true };
    });
  }

  deleteCustom(payload) {
    const scope = normalizeScope(payload.scope);
    const name = validateSkillName(payload.name);
    return this.mutateWithMaintenance(async () => {
      const filePath = path.join(this.rootForScope(scope), name, "SKILL.md");
      await this.assertSafeExistingSkill(scope, name, filePath);
      const locks = readSkillLocks({ homeDir: this.homeDir, cwd: this.cwd });
      if (annotateInstall({ name }, locks, scope)) throw statusError(409, "skills.sh管理的Skill必须使用卸载功能");
      const snapshot = await this.backupMutation(`delete-${scope}-${name}`, { scope, name });
      try { await rm(path.dirname(filePath), { recursive: true, force: false }); }
      catch (error) { error.message += `；备份位于 ${snapshot.dir}`; throw error; }
      return { deleted: true };
    });
  }

  async openDirectory(payload) {
    if (typeof payload.id !== 'string' || !payload.id) throw statusError(400, '缺少 Skill 标识');
    const directory = await this.directoryCache.resolve(payload.id);
    await this.openDirectoryImpl(directory);
    return { opened: true };
  }

  async transfer(payload) {
    const scope = normalizeScope(payload.scope), targetScope = scope === 'global' ? 'project' : 'global';
    const name = validateSkillName(payload.name);
    let moved;
    try { return await this.mutateWithMaintenance(async () => {
      const skill = await this.findSkill(scope, name);
      if (!skill.writable || skill.install) throw statusError(403, '只读或软件包管理的 Skill 不支持互转');
      if (!payload.revision || payload.revision !== skill.revision || payload.id !== skill.id) throw statusError(409, 'Skill 已变化，请刷新后重试');
      const locks = readSkillLocks({ homeDir: this.homeDir, cwd: this.cwd });
      if (annotateInstall({ name }, locks, targetScope)) throw statusError(409, '目标范围已有同名安装记录，不会覆盖');
      await this.assertSafeExistingSkill(scope, name, skill.filePath);
      const target = path.join(this.rootForScope(targetScope), name);
      const result = await transferSkillDirectory({ source: path.dirname(skill.filePath), target, backupDir: this.backupDir, expectedRevision: payload.revision });
      const filePath = path.join(target, 'SKILL.md');
      moved = { ...result, scope: targetScope, skillId: createHash('sha256').update(`${targetScope}\0${filePath}`).digest('hex').slice(0, 20) };
      return moved;
    }); } catch (error) {
      if (moved) return { ...moved, applied: false, warning: `Skill 已转换，但当前会话恢复失败，请重启工作台：${error.message}` };
      throw error;
    }
  }

  async validateRawContent(content, expectedName) {
    const parsed = parseSkillMarkdown(content);
    if (parsed.name !== expectedName) throw statusError(400, "frontmatter中的name必须与Skill目录名称一致");
    const sdk = await this.loadSdk(this.env);
    if (typeof sdk.parseFrontmatter === "function") {
      try {
        const result = sdk.parseFrontmatter(content);
        if (!result?.frontmatter || typeof result.frontmatter !== "object") throw new Error("frontmatter无效");
      } catch (error) { throw statusError(400, `YAML frontmatter无效：${error.message}`); }
    }
  }

  async findSkill(scope, name) {
    const listed = await this.list();
    const skill = listed.skills.find((item) => item.scope === scope && item.name.toLowerCase() === name.toLowerCase());
    if (!skill) throw statusError(404, "未找到该Skill，请刷新后重试");
    return skill;
  }

  async findManagedSkill(pkg, scope, expectedName) {
    const listed = await this.list();
    const skill = listed.skills.find((item) => item.scope === scope && item.install?.package === pkg && (!expectedName || item.name === expectedName));
    if (!skill) throw statusError(404, "未找到对应的skills.sh安装记录");
    return skill;
  }

  mutateWithMaintenance(operation) {
    return this.piAdmin.withMaintenance(async () => {
      this.directoryCache.clear();
      try { return await operation(); }
      finally { this.directoryCache.clear(); }
    });
  }

  async isCliAvailable() {
    const invocation = this.npxInvocation();
    if (invocation.cliPath && !existsSync(invocation.cliPath)) return false;
    try { await this.execFileImpl(invocation.command, [...invocation.prefix, "--version"], { timeout: 5_000, windowsHide: true, maxBuffer: 4096 }); return true; }
    catch { return false; }
  }

  async requireCli() {
    if (!(await this.isCliAvailable())) throw statusError(503, "未找到npm自带的npx CLI，当前只能浏览Skill；请先安装Windows Node.js/npm");
  }

  npxInvocation() {
    const nodeDir = path.dirname(process.execPath);
    const candidates = [
      this.env.SUPER_BAODAN_NPX_CLI,
      path.join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"),
      path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
      this.env.ProgramFiles ? path.join(this.env.ProgramFiles, "nodejs", "node_modules", "npm", "bin", "npx-cli.js") : null,
    ].filter(Boolean);
    const cliPath = candidates.find((candidate) => existsSync(candidate)) || candidates[0] || null;
    if (cliPath && existsSync(cliPath)) return { command: process.execPath, prefix: [cliPath], cliPath };
    return { command: "npx", prefix: [], cliPath: null };
  }

  async runCli(args) {
    const invocation = this.npxInvocation();
    try {
      const result = await this.execFileImpl(invocation.command, [...invocation.prefix, ...args], {
        cwd: args.includes("-g") ? undefined : this.cwd,
        env: { ...this.env, FORCE_COLOR: "0" },
        timeout: CLI_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: MAX_CLI_OUTPUT,
      });
      const output = `${result.stdout || ""}${result.stderr || ""}`.replace(ANSI_RE, "");
      if (!/Installation complete|Installed \d+ skill|Removed|Uninstalled|success/i.test(output)) {
        this.log.warn("Skill CLI未返回标准成功标记");
      }
      return output;
    } catch (error) {
      const raw = `${error.stdout || ""}${error.stderr || ""}${error.message || ""}`.replace(ANSI_RE, "");
      throw statusError(502, `Skill操作失败：${this.sanitizeOutput(raw)}`);
    }
  }

  sanitizeOutput(value) {
    let text = String(value || "操作失败");
    for (const sensitive of [this.homeDir, this.agentDir, this.cwd]) if (sensitive) text = text.split(sensitive).join("<本地路径>");
    return text.replace(/[\r\n]+/g, " ").slice(-500);
  }

  async checkOneUpdate(skill) {
    const install = skill.install;
    const base = { package: install.package, scope: install.scope, currentVersion: install.versionHash };
    if (!install.canCheckForUpdates) return { ...base, state: "unsupported", message: "该安装记录暂不支持自动检查" };
    try {
      let latestVersion;
      if (install.scope === "project") {
        const [owner, repo] = install.source.split("/");
        const response = await this.fetchImpl(`https://skills.sh/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(slug(skill.name))}`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        latestVersion = (await response.json()).hash;
      } else {
        const ref = install.ref || "HEAD";
        const response = await this.fetchImpl(`https://api.github.com/repos/${install.source}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "SuperBaodan" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const folder = skillFolder(install.skillPath || "");
        latestVersion = folder ? data.tree?.find((item) => item.type === "tree" && item.path === folder)?.sha : data.sha;
      }
      if (typeof latestVersion !== "string") throw new Error("远端未返回可比较版本");
      return { ...base, latestVersion, state: latestVersion === install.versionHash ? "up-to-date" : "update-available" };
    } catch (error) { return { ...base, state: "error", message: `检查失败：${error.message}` }; }
  }

  rootForScope(scope) {
    return scope === "global" ? this.globalRoot : this.projectRoot;
  }

  async isWritableSkillPath(scope, name, filePath) {
    const expected = path.join(this.rootForScope(scope), name, "SKILL.md");
    if (path.resolve(filePath).toLowerCase() !== path.resolve(expected).toLowerCase()) return false;
    try { await this.assertSafeExistingSkill(scope, name, filePath); return true; }
    catch { return false; }
  }

  async assertSafeRoot(root) {
    const resolved = await realpath(root);
    if (path.resolve(resolved).toLowerCase() !== path.resolve(root).toLowerCase()) throw statusError(403, "Skill根目录不能是符号链接");
  }

  async assertSafeManagedSkill(skill) {
    const scope = normalizeScope(skill.scope);
    const name = validateSkillName(skill.name);
    const expected = path.join(this.rootForScope(scope), name, "SKILL.md");
    if (path.resolve(skill.filePath).toLowerCase() !== path.resolve(expected).toLowerCase()) throw statusError(403, "skills.sh Skill路径与安装记录不一致");
    const realFile = await realpath(expected).catch(() => { throw statusError(404, "Skill文件不存在"); });
    const allowedRoots = [await realpath(this.rootForScope(scope)).catch(() => null)];
    if (scope === "global") allowedRoots.push(await realpath(path.join(this.homeDir, ".agents", "skills")).catch(() => null));
    if (!allowedRoots.filter(Boolean).some((root) => isInside(realFile, root))) throw statusError(403, "skills.sh Skill真实路径越界");
    const fileStat = await lstat(realFile);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw statusError(403, "拒绝操作异常Skill文件");
  }

  async assertSafeExistingSkill(scope, name, filePath) {
    const root = this.rootForScope(scope);
    const expected = path.join(root, validateSkillName(name), "SKILL.md");
    if (path.resolve(expected).toLowerCase() !== path.resolve(filePath).toLowerCase()) throw statusError(403, "Skill路径越界");
    await this.assertSafeRoot(root);
    const directory = path.dirname(expected);
    const [dirStat, fileStat] = await Promise.all([lstat(directory), lstat(expected)]).catch((error) => {
      if (error.code === "ENOENT") throw statusError(404, "Skill文件不存在");
      throw error;
    });
    if (dirStat.isSymbolicLink() || fileStat.isSymbolicLink() || !dirStat.isDirectory() || !fileStat.isFile()) throw statusError(403, "拒绝操作符号链接或异常Skill路径");
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(expected)]);
    if (!isInside(realFile, realRoot)) throw statusError(403, "Skill真实路径越界");
  }

  async backupMutation(label, { scope, name, includeRootListing = false }) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(this.backupDir, `skills-${stamp}-${safeSegment(label)}`);
    await mkdir(dir, { recursive: true });
    const root = this.rootForScope(scope);
    const skillDir = name ? path.join(root, validateSkillName(String(name).split("@").at(-1))) : null;
    const lockPath = scope === "global" ? this.globalLockPath : this.projectLockPath;
    if (skillDir && existsSync(skillDir)) await cp(skillDir, path.join(dir, "skill"), { recursive: true, dereference: true });
    if (includeRootListing && existsSync(root)) await cp(root, path.join(dir, "skills-root"), { recursive: true, dereference: true });
    if (existsSync(lockPath)) await cp(lockPath, path.join(dir, "skill-lock.json"));
    return { dir, scope, name: skillDir ? path.basename(skillDir) : null, hadSkill: Boolean(skillDir && existsSync(skillDir)), hadRoot: includeRootListing && existsSync(root), hadLock: existsSync(lockPath) };
  }

  async rollback(snapshot) {
    const root = this.rootForScope(snapshot.scope);
    const lockPath = snapshot.scope === "global" ? this.globalLockPath : this.projectLockPath;
    if (snapshot.hadRoot) {
      await rm(root, { recursive: true, force: true });
      await cp(path.join(snapshot.dir, "skills-root"), root, { recursive: true, dereference: true });
    } else if (snapshot.name) {
      const target = path.join(root, snapshot.name);
      await rm(target, { recursive: true, force: true });
      if (snapshot.hadSkill) await cp(path.join(snapshot.dir, "skill"), target, { recursive: true, dereference: true });
    }
    if (snapshot.hadLock) {
      await mkdir(path.dirname(lockPath), { recursive: true });
      await cp(path.join(snapshot.dir, "skill-lock.json"), lockPath);
    } else await rm(lockPath, { force: true });
  }
}

function normalizeScope(value) {
  if (value === "global" || value === "project") return value;
  throw statusError(400, "Skill范围必须是global或project");
}

function normalizeDescription(value) {
  const description = String(value || "").trim();
  if (!description) throw statusError(400, "Skill描述不能为空");
  if (description.length > 2000) throw statusError(400, "Skill描述不能超过2000字");
  return description;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function frontmatterSpans(lines, closing) {
  const spans = new Map();
  let active = null;
  for (let i = 1; i < closing; i++) {
    const match = lines[i].match(/^([A-Za-z0-9_-]+)\s*:/);
    if (!match) continue;
    if (active) active.end = i;
    if (spans.has(match[1])) throw statusError(400, `frontmatter包含重复字段：${match[1]}`);
    active = { start: i, end: closing };
    spans.set(match[1], active);
  }
  return spans;
}

function scalarFromSpan(lines, span) {
  if (!span) return "";
  const first = lines[span.start].replace(/^[^:]+:\s*/, "").trim();
  if (first === "|" || first === ">" || first.startsWith("|-") || first.startsWith(">-")) {
    return lines.slice(span.start + 1, span.end).map((line) => line.replace(/^\s{1,4}/, "")).join(" ").trim();
  }
  if ((first.startsWith('"') && first.endsWith('"')) || (first.startsWith("'") && first.endsWith("'"))) {
    if (first.startsWith('"')) { try { return JSON.parse(first); } catch {} }
    return first.slice(1, -1).replace(/''/g, "'");
  }
  return first.replace(/\s+#.*$/, "").trim();
}

function readLockSync(filePath) {
  try {
    const value = JSON.parse(requireReadFile(filePath));
    return value?.skills && typeof value.skills === "object" ? value.skills : {};
  } catch { return {}; }
}

function requireReadFile(filePath) {
  return globalThis.process.getBuiltinModule("node:fs").readFileSync(filePath, "utf8");
}

function findLockEntry(entries, name) {
  if (!entries || typeof entries !== "object") return null;
  if (entries[name]) return entries[name];
  const key = Object.keys(entries).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? entries[key] : null;
}

function normalizeSource(source, type) {
  let value = String(source).trim().replace(/\/$/, "");
  if (type === "github") value = value.replace(/^git\+/, "").replace(/^https?:\/\/github\.com\//, "").replace(/^git@github\.com:/, "").replace(/\.git$/, "");
  return value;
}

function validateRepository(value) {
  const source = String(value || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(source)) throw statusError(400, "安装记录中的GitHub来源无效");
  return source;
}

function skillFolder(value) {
  let folder = String(value || "").replace(/\\/g, "/");
  folder = folder.replace(/\/?SKILL\.md$/i, "").replace(/^\/+|\/+$/g, "");
  if (folder.split("/").some((item) => item === ".." || item === ".")) throw statusError(400, "安装记录中的Skill路径无效");
  return folder;
}

function normalizeSearchResult(item) {
  const name = typeof item?.name === "string" ? item.name.trim() : "";
  const source = typeof item?.source === "string" ? item.source.trim() : "";
  const slugValue = typeof item?.id === "string" ? item.id.trim() : "";
  if (!name || (!source && !slugValue)) return null;
  const repository = source || slugValue.split("/").slice(0, 2).join("/");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !SKILL_NAME_RE.test(name)) return null;
  return {
    name,
    description: typeof item.description === "string" ? item.description : "",
    package: `${repository}@${name}`,
    source: repository,
    installs: Number.isFinite(Number(item.installs)) ? Number(item.installs) : 0,
    url: `https://skills.sh/${slugValue || `${repository}/${name}`}`,
  };
}

function safeDiagnostic(item) {
  if (!item || typeof item !== "object") return { message: String(item) };
  return {
    severity: item.severity || item.level || "warning",
    message: String(item.message || item.error || "Skill加载诊断"),
    path: item.path || item.filePath || null,
  };
}

async function listAuxiliaryFiles(root) {
  const output = [];
  async function walk(directory, prefix, depth) {
    if (depth > 4 || output.length >= 100) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === "SKILL.md" || entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative, depth + 1);
      else if (entry.isFile()) output.push(relative);
      if (output.length >= 100) break;
    }
  }
  await walk(root, "", 0);
  return output;
}

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.SKILL-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temp, String(content), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, filePath);
  } catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; }
}

function isInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeSegment(value) {
  return String(value || "skill").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100);
}

function slug(value) {
  return String(value || "").toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
