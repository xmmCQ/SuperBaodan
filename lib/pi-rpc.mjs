import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const SHELL_WRAPPER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/shell-wrappers");

const RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const ACTIVITY_COMMANDS = new Set(["prompt", "steer", "follow_up", "bash", "compact", "set_model", "set_thinking_level", "set_session_name"]);
const ACTIVITY_EVENTS = new Set(["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "bash_execution_update", "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end"]);

export class PiRpcRuntime extends EventEmitter {
  constructor({ cwd, sessionDir, agentDir, log, idleTimeoutMs, stopTimeoutMs, startupProbeMs = 250, gracefulEofMs = 250, spawnProcess = spawn, terminateTree = defaultTerminateTree, platform = process.platform }) {
    super();
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    this.agentDir = agentDir;
    this.log = log || console;
    this.idleTimeoutMs = positiveNumber(idleTimeoutMs ?? process.env.SUPER_BAODAN_PI_IDLE_MS, DEFAULT_IDLE_TIMEOUT_MS);
    this.stopTimeoutMs = positiveNumber(stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
    this.startupProbeMs = Math.max(0, Number(startupProbeMs) || 0);
    this.gracefulEofMs = Math.max(0, Number(gracefulEofMs) || 0);
    this.spawnProcess = spawnProcess;
    this.terminateTree = terminateTree;
    this.platform = platform;
    this.child = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.transitionTail = Promise.resolve();
    this.stopping = false;
    this.closed = false;
    this.activeSessionPath = null;
    this.idleTimer = null;
    this.busyReasons = new Set();
    this.expectedStops = new WeakMap();
    this.runtimeState = "stopped";
  }

  get running() {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
  }

  get state() {
    if (this.stopping) return this.runtimeState;
    if (this.running && this.busyReasons.size) return "busy";
    if (this.running) return "running";
    return this.runtimeState;
  }

  findCliFile() {
    const packageRoot = process.env.SUPER_BAODAN_PI_PACKAGE
      || path.join(process.env.APPDATA || "", "npm", "node_modules", "@earendil-works", "pi-coding-agent");
    const packageFile = path.join(packageRoot, "package.json");
    if (!existsSync(packageFile)) return null;
    try {
      const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
      const relative = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
      return relative ? path.join(packageRoot, relative) : null;
    } catch {
      return null;
    }
  }

  enqueueTransition(operation) {
    const result = this.transitionTail.then(operation, operation);
    this.transitionTail = result.catch(() => {});
    return result;
  }

  async ensureStarted(sessionPath = this.activeSessionPath) {
    if (this.closed) throw new Error("Windows Pi 运行时已关闭");
    if (this.running && !this.stopping && sessionPath === this.activeSessionPath) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.enqueueTransition(() => this.startInternal(sessionPath))
      .finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async start(sessionPath = null) {
    if (this.closed) throw new Error("Windows Pi 运行时已关闭");
    return this.enqueueTransition(() => this.startInternal(sessionPath));
  }

  async startInternal(sessionPath = null) {
    await this.performStop("restart");
    this.runtimeState = "starting";
    await Promise.all([
      mkdir(this.cwd, { recursive: true }),
      mkdir(this.sessionDir, { recursive: true }),
    ]);
    const cliFile = this.findCliFile();
    if (!cliFile || !existsSync(cliFile)) {
      this.runtimeState = "error";
      const error = new Error("未找到 Windows Pi。请执行 npm.cmd install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4");
      this.emit("event", { type: "runtime_exit", phase: "startup", error: error.message });
      throw error;
    }

    const args = [cliFile, "--mode", "rpc", "--session-dir", this.sessionDir, "--approve"];
    if (sessionPath) args.push("--session", sessionPath);
    const runtimeEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: this.agentDir,
      AI_AGENT: "pi",
      PI_CODING_AGENT: "true",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    };
    if (this.platform === "win32") {
      const pathKey = Object.keys(runtimeEnv).find((key) => key.toLowerCase() === "path") || "PATH";
      runtimeEnv[pathKey] = [SHELL_WRAPPER_DIR, runtimeEnv[pathKey]].filter(Boolean).join(path.delimiter);
    }
    let child;
    try {
      child = this.spawnProcess(process.execPath, args, {
        cwd: this.cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: runtimeEnv,
      });
    } catch (error) {
      this.runtimeState = "error";
      this.emit("event", { type: "runtime_exit", phase: "startup", error: error.message });
      throw error;
    }
    this.child = child;
    this.activeSessionPath = sessionPath;
    this.buffer = "";
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk) => this.log.error(`[windows-pi] ${chunk.toString("utf8").trimEnd()}`));
    child.on("error", (error) => {
      if (this.expectedStops.has(child) || this.child !== child) return;
      this.expectedStops.set(child, "runtime_error");
      this.child = null;
      this.clearIdleTimer();
      this.busyReasons.clear();
      this.runtimeState = "error";
      this.failAll(error);
      try { child.stdin.end(); } catch {}
      try { child.kill("SIGKILL"); } catch {}
      this.emit("event", { type: "runtime_exit", phase: "runtime", error: error.message });
    });
    child.on("exit", (code, signal) => {
      const reason = this.expectedStops.get(child);
      const isCurrent = this.child === child;
      if (isCurrent) {
        this.child = null;
        this.clearIdleTimer();
        this.busyReasons.clear();
      }
      if (reason) {
        if (["startup_failure", "runtime_error"].includes(reason)) return;
        if (!isCurrent) return;
        this.runtimeState = reason === "idle" ? "idle" : "stopped";
        this.emit("event", reason === "idle"
          ? { type: "runtime_idle", reason, idleTimeoutMs: this.idleTimeoutMs }
          : { type: "runtime_stopped", reason, code, signal });
        return;
      }
      if (!isCurrent) return;
      this.runtimeState = "error";
      const error = new Error(`Windows Pi 已退出（code=${code}, signal=${signal || "none"}）`);
      this.failAll(error);
      this.emit("event", { type: "runtime_exit", code, signal });
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.startupProbeMs);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code) => {
          if (code !== null) { clearTimeout(timer); reject(new Error(`Windows Pi 启动失败：${code}`)); }
        });
      });
      const state = await this.send({ type: "get_state" });
      this.activeSessionPath = state?.sessionFile || sessionPath || null;
      this.runtimeState = "running";
      this.scheduleIdleTimer();
      this.emit("event", { type: "runtime_ready", state, idleTimeoutMs: this.idleTimeoutMs });
    } catch (error) {
      const alreadyReported = this.expectedStops.get(child) === "runtime_error";
      if (this.child === child) {
        this.expectedStops.set(child, "startup_failure");
        await this.performStop("startup_failure");
      }
      this.runtimeState = "error";
      if (!alreadyReported) this.emit("event", { type: "runtime_exit", phase: "startup", error: error.message });
      throw error;
    }
  }

  handleStdout(chunk) {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch (error) {
        this.log.error("Windows Pi 输出了无效 JSON：", line, error);
        continue;
      }
      if (message.type === "response" && message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (pending.busyKey) this.setBusy(pending.busyKey, false);
        else if (this.pending.size === 0 && this.running) this.scheduleIdleTimer();
        if (message.success) pending.resolve(message.data ?? null);
        else pending.reject(new Error(message.error || `${message.command || "command"} 执行失败`));
      } else {
        this.trackAgentEvent(message);
        this.emit("event", message);
      }
    }
  }

  async send(command, timeoutMs = RESPONSE_TIMEOUT_MS) {
    if (this.closed) throw new Error("Windows Pi 运行时已关闭");
    if (!this.running || this.stopping) await this.ensureStarted();
    if (!this.child?.stdin?.writable) throw new Error("Windows Pi 尚未就绪");
    if (ACTIVITY_COMMANDS.has(command.type)) this.markActivity();
    const id = `web-${this.nextId++}`;
    const payload = { ...command, id };
    const busyKey = command.type === "bash" ? `bash:${id}` : null;
    if (busyKey) this.setBusy(busyKey, true);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (busyKey) this.setBusy(busyKey, false);
        else if (this.pending.size === 0 && this.running) this.scheduleIdleTimer();
        reject(new Error(`${command.type} 等待响应超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, busyKey });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        if (busyKey) this.setBusy(busyKey, false);
        else if (this.pending.size === 0 && this.running) this.scheduleIdleTimer();
        reject(error);
      });
    });
  }

  async newSession() {
    if (this.closed) throw new Error("Windows Pi 运行时已关闭");
    return this.enqueueTransition(async () => {
      this.activeSessionPath = null;
      await this.startInternal(null);
      return this.send({ type: "get_state" });
    });
  }

  async renameSession(sessionPath, name) {
    if (this.closed) throw new Error("Windows Pi 运行时已关闭");
    const safePath = await assertPathInside(sessionPath, this.sessionDir);
    const cleanName = String(name || "").trim();
    if (!cleanName || cleanName.length > 120) {
      const error = new Error("会话名称应为 1 至 120 个字符");
      error.statusCode = 400;
      throw error;
    }
    if (this.busyReasons.size || this.pending.size) {
      const error = new Error("当前对话正在运行，请等待完成后再重命名");
      error.statusCode = 409;
      throw error;
    }
    return this.enqueueTransition(async () => {
      const previousPath = this.activeSessionPath;
      const isActive = previousPath && samePath(safePath, previousPath);
      if (!isActive) await this.startInternal(safePath);
      await this.send({ type: "set_session_name", name: cleanName });
      if (!isActive && previousPath && existsSync(previousPath)) await this.startInternal(previousPath);
      const state = await this.send({ type: "get_state" });
      return { renamed: true, state };
    });
  }

  async openSession(sessionPath) {
    if (this.closed) throw new Error("Windows Pi 运行时已关闭");
    const safePath = await assertPathInside(sessionPath, this.sessionDir);
    return this.enqueueTransition(async () => {
      await this.startInternal(safePath);
      return this.send({ type: "get_state" });
    });
  }

  async deleteSession(sessionPath) {
    if (this.closed) throw new Error("Windows Pi 运行时已关闭");
    const safePath = resolvePathInside(sessionPath, this.sessionDir);
    const isActivePath = this.activeSessionPath && samePath(safePath, this.activeSessionPath);
    if (!existsSync(safePath) && !isActivePath) throw new Error("会话不存在");
    return this.enqueueTransition(async () => {
      const isActive = this.activeSessionPath && samePath(safePath, this.activeSessionPath);
      if (!existsSync(safePath) && !isActive) throw new Error("会话不存在");
      if (isActive && (this.busyReasons.size || this.pending.size)) {
        const error = new Error("当前对话正在运行，请停止或等待完成后再删除");
        error.statusCode = 409;
        throw error;
      }
      let state = null;
      if (isActive) {
        this.activeSessionPath = null;
        await this.startInternal(null);
        state = await this.send({ type: "get_state" });
      }
      if (existsSync(safePath)) await unlink(safePath);
      return { deleted: true, activeDeleted: Boolean(isActive), state };
    });
  }

  markActivity() {
    if (this.running) this.scheduleIdleTimer();
  }

  trackAgentEvent(event) {
    if (ACTIVITY_EVENTS.has(event.type)) this.markActivity();
    if (event.type === "agent_start") this.setBusy("agent", true);
    if (event.type === "agent_settled") this.setBusy("agent", false);
    if (event.type === "compaction_start") this.setBusy("compaction", true);
    if (event.type === "compaction_end") this.setBusy("compaction", false);
    if (event.type === "auto_retry_start") this.setBusy("retry", true);
    if (event.type === "auto_retry_end") this.setBusy("retry", false);
  }

  setBusy(reason, busy) {
    if (busy) this.busyReasons.add(reason);
    else this.busyReasons.delete(reason);
    if (this.running) {
      this.runtimeState = this.busyReasons.size ? "busy" : "running";
      this.scheduleIdleTimer();
    }
  }

  scheduleIdleTimer() {
    this.clearIdleTimer();
    if (!this.running) return;
    this.idleTimer = setTimeout(() => void this.handleIdleTimeout(), this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async handleIdleTimeout() {
    this.idleTimer = null;
    if (!this.running) return;
    if (this.busyReasons.size || this.pending.size) {
      this.scheduleIdleTimer();
      return;
    }
    await this.stop("idle");
  }

  async stop(reason = "manual") {
    return this.enqueueTransition(() => this.performStop(reason));
  }

  async close() {
    if (this.closed) return this.transitionTail;
    this.closed = true;
    return this.stop("shutdown");
  }

  async performStop(reason) {
    this.stopping = true;
    this.clearIdleTimer();
    const child = this.child;
    if (!child) {
      if (reason === "idle") this.runtimeState = "idle";
      this.stopping = false;
      return;
    }
    this.expectedStops.set(child, reason);
    this.runtimeState = reason === "idle" ? "idle" : "stopped";
    if (reason !== "startup_failure") this.emit("event", { type: "runtime_stopping", reason });
    this.failAll(new Error(reason === "restart" ? "Windows Pi 正在重启" : "Windows Pi 正在关闭"));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try { child.stdin.end(); } catch {}
    let graceful = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), Math.min(this.gracefulEofMs, this.stopTimeoutMs))),
    ]);
    if (!graceful && child.exitCode === null) {
      if (this.platform === "win32" && child.pid) {
        await this.terminateTree(child.pid).catch((error) => this.log.warn(`结束 Windows Pi 进程树失败：${error.message}`));
      } else {
        try { child.kill("SIGTERM"); } catch {}
      }
      graceful = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), Math.max(0, this.stopTimeoutMs - this.gracefulEofMs))),
      ]);
    }
    if (!graceful && child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch {}
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
    this.stopping = false;
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.busyKey) this.busyReasons.delete(pending.busyKey);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async listSessions() {
    await mkdir(this.sessionDir, { recursive: true });
    const files = await walkJsonl(this.sessionDir);
    const sessions = [];
    for (const file of files) {
      try {
        const info = await readSessionSummary(file);
        if (info) sessions.push(info);
      } catch (error) {
        this.log.warn(`跳过无法读取的会话 ${file}: ${error.message}`);
      }
    }
    return sessions.sort((a, b) => b.modified.localeCompare(a.modified));
  }
}

async function walkJsonl(root) {
  const result = [];
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(full);
    }
  }
  return result;
}

async function readSessionSummary(file) {
  const [content, fileStat] = await Promise.all([readFile(file, "utf8"), stat(file)]);
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  const header = JSON.parse(lines[0]);
  if (header.type !== "session" || !header.id) return null;
  let name = "";
  let firstMessage = "";
  let messageCount = 0;
  for (const line of lines.slice(1)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
    if (entry.type !== "message") continue;
    messageCount += 1;
    if (!firstMessage && entry.message?.role === "user") firstMessage = messageText(entry.message);
  }
  return {
    id: header.id,
    path: file,
    cwd: header.cwd,
    name: name || null,
    title: name || firstMessage.slice(0, 60) || "新对话",
    firstMessage,
    messageCount,
    created: header.timestamp || fileStat.birthtime.toISOString(),
    modified: fileStat.mtime.toISOString(),
  };
}

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("");
}

function defaultTerminateTree(pid) {
  return new Promise((resolve, reject) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
      if (error && ![128, 255].includes(error.code)) reject(error);
      else resolve();
    });
  });
}

function samePath(left, right) {
  const normalize = (value) => path.resolve(value).replace(/\\/g, "/").toLowerCase();
  return normalize(left) === normalize(right);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePathInside(candidate, root) {
  const absolute = path.resolve(candidate);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !absolute.endsWith(".jsonl")) {
    throw new Error("会话路径不合法");
  }
  return absolute;
}

async function assertPathInside(candidate, root) {
  const absolute = resolvePathInside(candidate, root);
  if (!existsSync(absolute)) throw new Error("会话不存在");
  const [actual, actualRoot] = await Promise.all([realpath(absolute), realpath(root)]);
  const relative = path.relative(actualRoot, actual);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !actual.endsWith(".jsonl")) throw new Error("会话路径不合法");
  return actual;
}
