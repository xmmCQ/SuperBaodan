import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fault } from '../../shared/errors.js';
import { validateSkillName } from './skill-markdown.mjs';
const execFileAsync = promisify(execFile);

const PACKAGE_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*(?:@[A-Za-z0-9][\w.-]*)?$/;

const ANSI_RE = /\x1B\[[0-9;]*m/g;

const CLI_TIMEOUT_MS = 90_000;

const MAX_CLI_OUTPUT = 32_000;

export function validateSkillPackage(value) {
  const pkg = String(value || "").trim();
  if (!PACKAGE_RE.test(pkg) || pkg.split(/[\/@]/).some((part) => part.startsWith("-"))) {
    throw fault(400, "Skill来源格式无效，应为 owner/repo 或 owner/repo@skill");
  }
  return pkg;
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
    if (!install) throw fault(400, "缺少安装记录");
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
  throw fault(400, "未知Skill CLI操作");
}

export function normalizeScope(value) {
  if (value === "global" || value === "project") return value;
  throw fault(400, "Skill范围必须是global或project");
}

function validateRepository(value) {
  const source = String(value || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(source)) throw fault(400, "安装记录中的GitHub来源无效");
  return source;
}

export function skillFolder(value) {
  let folder = String(value || "").replace(/\\/g, "/");
  folder = folder.replace(/\/?SKILL\.md$/i, "").replace(/^\/+|\/+$/g, "");
  if (folder.split("/").some((item) => item === ".." || item === ".")) throw fault(400, "安装记录中的Skill路径无效");
  return folder;
}

export class SkillCli {
  constructor({ env = process.env, execFileImpl = execFileAsync, log = console } = {}) {
    this.env = env; this.execFileImpl = execFileImpl; this.log = log;
  }

  async isCliAvailable() {
    const invocation = this.npxInvocation();
    if (invocation.cliPath && !existsSync(invocation.cliPath)) return false;
    try { await this.execFileImpl(invocation.command, [...invocation.prefix, "--version"], { timeout: 5_000, windowsHide: true, maxBuffer: 4096 }); return true; }
    catch { return false; }
  }

  async requireCli() {
    if (!(await this.isCliAvailable())) throw fault(503, "未找到npm自带的npx CLI，当前只能浏览Skill；请先安装Windows Node.js/npm");
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

  async runCli(args, { cwd, sensitivePaths = [] } = {}) {
    const invocation = this.npxInvocation();
    try {
      const result = await this.execFileImpl(invocation.command, [...invocation.prefix, ...args], {
        cwd: args.includes("-g") ? undefined : cwd,
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
      throw fault(502, `Skill操作失败：${this.sanitizeOutput(raw, sensitivePaths)}`);
    }
  }

  sanitizeOutput(value, sensitivePaths = []) {
    let text = String(value || "操作失败");
    for (const sensitive of sensitivePaths) if (sensitive) text = text.split(sensitive).join("<本地路径>");
    return text.replace(/[\r\n]+/g, " ").slice(-500);
  }

}
