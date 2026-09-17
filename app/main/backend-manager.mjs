import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { createBackendEnvironment } from "./config.mjs";
import { RotatingLogWriter } from "./log-writer.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BackendManager extends EventEmitter {
  constructor(config, dependencies = {}) {
    super();
    this.config = config;
    this.root = config.root;
    this.dataRoot = config.dataRoot;
    this.nodePath = config.nodePath;
    this.spawnProcess = dependencies.spawnProcess || spawn;
    this.prepare = dependencies.prepare || (() => this.initialize());
    this.createLogWriter = dependencies.createLogWriter || ((file) => new RotatingLogWriter(file, { onError: (error) => this.reportLogError(error) }));
    this.startupTimeoutMs = dependencies.startupTimeoutMs || 30_000;
    this.stopTimeoutMs = dependencies.stopTimeoutMs || 8_000;
    this.killTimeoutMs = dependencies.killTimeoutMs || 2_000;
    this.state = "idle";
    this.currentRun = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.forcePromise = null;
    this.lastReady = null;
    this.logError = null;
    this.logDir = path.join(this.dataRoot, "logs");
    this.stdoutLog = path.join(this.logDir, "server.log");
    this.stderrLog = path.join(this.logDir, "server-error.log");
  }

  async initialize() {
    await Promise.all([
      mkdir(this.dataRoot, { recursive: true }),
      mkdir(this.logDir, { recursive: true }),
      mkdir(path.join(this.dataRoot, "workspace"), { recursive: true }),
      mkdir(this.config.piAgentDir, { recursive: true }),
    ]);
    const todoFile = path.join(this.dataRoot, "work-todo.md");
    try { await readFile(todoFile); }
    catch { await copyFile(path.join(this.root, "app", "main", "default-work-todo.md"), todoFile); }
  }

  start() {
    if (this.state === "running") return Promise.resolve(this.lastReady);
    if (this.startPromise) return this.startPromise;
    if (this.state === "stopping" && this.stopPromise) return this.stopPromise.then((stopped) => {
      if (!stopped) throw new BackendStartError("STOP_INCOMPLETE", "后台服务尚未停止");
      return this.start();
    });
    const run = this.createRun();
    this.currentRun = run;
    this.state = "starting";
    const operation = this.startRun(run);
    this.startPromise = operation;
    operation.finally(() => { if (this.startPromise === operation) this.startPromise = null; }).catch(() => {});
    return operation;
  }

  createRun() {
    const run = {
      id: randomUUID(),
      controller: new AbortController(),
      child: null,
      ready: null,
      exitInfo: null,
      shutdownRequested: false,
      stdout: this.createLogWriter(this.stdoutLog),
      stderr: this.createLogWriter(this.stderrLog),
    };
    run.exitPromise = new Promise((resolve) => { run.resolveExit = resolve; });
    return run;
  }

  async startRun(run) {
    try {
      await this.prepare(run.controller.signal);
      this.assertStartActive(run);
      const child = this.spawnProcess(this.nodePath, [path.join(this.root, "app", "services", "main.mjs")], {
        cwd: this.root,
        windowsHide: true,
        serialization: "advanced",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: createBackendEnvironment(this.config, run.id),
      });
      run.child = child;
      this.bindChild(run, child);
      this.assertStartActive(run);
      const ready = await this.waitForReady(run);
      this.assertStartActive(run);
      this.state = "running";
      this.lastReady = ready;
      this.emit("state", { state: this.state, runId: run.id });
      return ready;
    } catch (error) {
      if (isStartCancelled(error) || run.controller.signal.aborted) throw new BackendStartCancelled();
      if (this.currentRun === run) this.state = "failed";
      if (run.child && !run.exitInfo) await this.terminateRun(run);
      throw error;
    }
  }

  assertStartActive(run) {
    if (run.controller.signal.aborted || this.currentRun !== run || this.state !== "starting") throw new BackendStartCancelled();
  }

  bindChild(run, child) {
    child.stdout?.on("data", (chunk) => run.stdout.push(chunk));
    child.stderr?.on("data", (chunk) => run.stderr.push(chunk));
    child.on("message", (message) => this.handleMessage(run, message));
    child.once("error", (error) => {
      run.startError = error;
      run.rejectReady?.(new BackendStartError("SPAWN_ERROR", error.message));
    });
    child.once("exit", (code, signal) => void this.handleExit(run, code, signal));
  }

  handleMessage(run, message) {
    if (!message || typeof message !== "object" || message.runId !== run.id) return;
    this.emit("message", { run, message });
    if (message.type === "ready") {
      run.resolveReady?.({ ok: true, desktopInstanceId: run.id });
    } else if (message.type === "startup-error") {
      run.rejectReady?.(new BackendStartError("STARTUP_ERROR", String(message.message || "后台服务启动失败")));
    } else if (message.type === "shutdown-error") {
      this.emit("shutdown-error", { runId: run.id, message: String(message.message || "后台服务关闭失败") });
    }
  }

  waitForReady(run) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run.controller.signal.removeEventListener("abort", cancelled);
        callback(value);
      };
      const cancelled = () => finish(reject, new BackendStartCancelled());
      const timer = setTimeout(() => finish(reject, new BackendStartError("TIMEOUT", "后台服务启动超时")), this.startupTimeoutMs);
      run.resolveReady = (value) => finish(resolve, value);
      run.rejectReady = (error) => finish(reject, error);
      run.controller.signal.addEventListener("abort", cancelled, { once: true });
      if (run.exitInfo) finish(reject, new BackendStartError("EARLY_EXIT", `后台服务提前退出（代码 ${run.exitInfo.code ?? "未知"}）`));
    });
  }

  async handleExit(run, code, signal) {
    run.exitInfo = { code, signal };
    await Promise.race([Promise.all([run.stdout.close(), run.stderr.close()]), wait(1_500)]);
    run.resolveExit(run.exitInfo);
    run.rejectReady?.(new BackendStartError("EARLY_EXIT", `后台服务提前退出（代码 ${code ?? "未知"}）`));
    if (this.currentRun !== run) return;
    const expected = this.state === "stopping" || run.shutdownRequested;
    this.currentRun = null;
    this.lastReady = null;
    this.state = expected ? "idle" : "failed";
    this.emit("exit", { runId: run.id, code, signal, expected });
    this.emit("state", { state: this.state, runId: run.id });
  }

  stop(timeoutMs = this.stopTimeoutMs) {
    if (this.stopPromise) return this.stopPromise;
    const operation = this.stopInternal(timeoutMs);
    this.stopPromise = operation;
    operation.finally(() => { if (this.stopPromise === operation) this.stopPromise = null; }).catch(() => {});
    return operation;
  }

  async stopInternal(timeoutMs) {
    const run = this.currentRun;
    if (!run) { this.state = "idle"; return true; }
    this.state = "stopping";
    run.controller.abort();
    if (this.startPromise) await waitForPromise(this.startPromise.catch((error) => { if (!isStartCancelled(error)) this.emit("start-error", error); }), timeoutMs);
    if (this.currentRun !== run) return true;
    if (run.exitInfo) return Boolean(await waitForPromise(run.exitPromise, timeoutMs));
    if (!run.child) {
      this.currentRun = null;
      this.state = "idle";
      return true;
    }
    run.shutdownRequested = true;
    try { run.child.send?.({ type: "shutdown", runId: run.id }); }
    catch (error) { this.emit("shutdown-error", { runId: run.id, message: error.message }); }
    const exited = await waitForPromise(run.exitPromise, timeoutMs);
    return Boolean(exited && run.exitInfo);
  }

  forceStop() {
    if (this.forcePromise) return this.forcePromise;
    const operation = this.forceStopInternal();
    this.forcePromise = operation;
    operation.finally(() => { if (this.forcePromise === operation) this.forcePromise = null; }).catch(() => {});
    return operation;
  }

  async forceStopInternal() {
    const run = this.currentRun;
    if (!run) { this.state = "idle"; return true; }
    this.state = "stopping";
    run.controller.abort();
    if (this.startPromise) await waitForPromise(this.startPromise.catch(() => {}), this.killTimeoutMs);
    if (run.exitInfo || this.currentRun !== run) return true;
    if (!run.child) { this.currentRun = null; this.state = "idle"; return true; }
    if (!safeKill(run.child, "SIGTERM")) return false;
    if (await waitForPromise(run.exitPromise, this.killTimeoutMs)) return true;
    if (!safeKill(run.child, "SIGKILL")) return false;
    return Boolean(await waitForPromise(run.exitPromise, this.killTimeoutMs));
  }

  async terminateRun(run) {
    if (!run.child || run.exitInfo) return true;
    safeKill(run.child, "SIGTERM");
    if (await waitForPromise(run.exitPromise, this.killTimeoutMs)) return true;
    safeKill(run.child, "SIGKILL");
    return Boolean(await waitForPromise(run.exitPromise, this.killTimeoutMs));
  }

  logDesktopError(message) {
    const line = `[desktop] ${new Date().toISOString()} ${String(message || "未知错误")}\n`;
    if (this.currentRun?.stderr) {
      this.currentRun.stderr.push(line);
      return Promise.resolve();
    }
    const writer = this.createLogWriter(this.stderrLog);
    writer.push(line);
    return writer.close();
  }

  reportLogError(error) {
    this.logError = error;
    this.emit("log-error", error);
  }
}

export class BackendStartError extends Error {
  constructor(code, message) { super(message); this.name = "BackendStartError"; this.code = code; }
}

export class BackendStartCancelled extends Error {
  constructor() { super("后台启动已取消"); this.name = "BackendStartCancelled"; this.code = "START_CANCELLED"; }
}

export function isStartCancelled(error) { return error?.code === "START_CANCELLED"; }

function safeKill(child, signal) {
  try { return child.kill(signal) !== false; } catch { return false; }
}

async function waitForPromise(promise, timeoutMs) {
  return Promise.race([promise.then((value) => value || true), wait(timeoutMs).then(() => false)]);
}
