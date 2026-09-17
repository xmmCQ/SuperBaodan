import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { createSdkHost, findSdkEntry, renameSavedSession } from "./pi-sdk-factory.mjs";
import { assertSessionPath, invalidateSavedSession, listSavedSessions, resolveSessionPath, sameSessionPath } from "./pi-session-store.mjs";
import { createSdkUi, toBrowserAgentEvent } from "./pi-sdk-ui.mjs";
import { dispatchSdkCommand, sessionState } from "./pi-sdk-commands.mjs";
import { assertAllowedAgentCommand } from "./agent-commands.mjs";

const ACTIVITY_COMMANDS = new Set(["prompt", "steer", "follow_up", "bash", "compact", "set_model", "set_thinking_level", "set_session_name"]);
const ACTIVITY_EVENTS = new Set(["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "bash_execution_update", "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end"]);
const busyError = (message = "Windows Pi 正在切换或关闭，请稍后重试") => Object.assign(new Error(message), { statusCode: 409 });

export class PiSdkRuntime extends EventEmitter {
  constructor({ cwd, sessionDir, agentDir, log = console, idleTimeoutMs, stopTimeoutMs = 5000, createHost = createSdkHost, renameSaved = renameSavedSession }) {
    super();
    Object.assign(this, { cwd, sessionDir, agentDir, log, createHost, renameSaved });
    this.idleTimeoutMs = positiveNumber(idleTimeoutMs ?? process.env.SUPER_BAODAN_PI_IDLE_MS, 600000);
    this.stopTimeoutMs = positiveNumber(stopTimeoutMs, 5000);
    this.host = null;
    this.snapshotEpoch = randomUUID();
    this.messageRevision = 0;
    this.lastSessionState = {};
    this.uiBridge = null;
    this.unsubscribe = null;
    this.activeSessionPath = null;
    this.unsavedManager = null;
    this.pending = new Map();
    this.promptRuns = new Map();
    this.busyReasons = new Set();
    this.nextId = 1;
    this.transitionTail = Promise.resolve();
    this.transitionCount = 0;
    this.startPromise = null;
    this.cleanupPromise = null;
    this.promptAdmissionTail = Promise.resolve();
    this.abortVersion = 0;
    this.closed = false;
    this.stopping = false;
    this.stopRequests = 0;
    this.idleTimer = null;
    this.runtimeState = "stopped";
    this.shutdownRequested = false;
  }

  get running() { return Boolean(this.host); }
  get state() {
    if (this.stopping || this.runtimeState === "starting" || this.runtimeState === "error") return this.runtimeState;
    return this.running ? (this.isBusy() ? "busy" : "running") : this.runtimeState;
  }
  findSdkEntry() { return findSdkEntry(); }
  isBusy() {
    const session = this.host?.session;
    return Boolean(this.busyReasons.size || this.promptRuns.size || session?.isStreaming || session?.isCompacting || session?.isBashRunning);
  }
  listSessions() { return listSavedSessions(this.sessionDir, this.log); }
  invalidateSession(file = this.activeSessionPath) {
    if (file) invalidateSavedSession(this.sessionDir, file);
  }
  pendingUiRequests() { return this.uiBridge?.requests() || []; }
  snapshot({ messages = false, since } = {}) {
    if (this.transitionCount || this.stopping) throw busyError();
    const session = this.host?.session;
    const state = session ? { ...sessionState(session), isStreaming: this.isBusy() } : { ...this.lastSessionState, isStreaming: false, isCompacting: false };
    const messagesVersion = `${this.snapshotEpoch}:${state.sessionId || "none"}:${this.messageRevision}`;
    return { state, messagesVersion, ...(messages && since !== messagesVersion && session ? { messages: session.messages } : {}) };
  }

  enqueueTransition(operation) {
    this.transitionCount += 1;
    const result = this.transitionTail.then(operation, operation).finally(() => { this.transitionCount -= 1; });
    this.transitionTail = result.catch(() => {});
    return result;
  }

  async ensureStarted(sessionPath = this.activeSessionPath) {
    if (this.closed) throw new Error("Windows Pi 运行时已关闭");
    if (this.startPromise) return this.startPromise;
    if (this.stopping || this.transitionCount) throw busyError();
    if (this.running && sameSessionPath(sessionPath, this.activeSessionPath)) return;
    this.startPromise = this.enqueueTransition(() => this.startInternal(sessionPath)).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }
  start(sessionPath = null) { return this.enqueueTransition(() => this.startInternal(sessionPath)); }

  async startInternal(sessionPath) {
    if (this.closed) throw new Error("Windows Pi 运行时已关闭");
    await this.performStop("restart");
    if (this.closed) throw new Error("Windows Pi 运行时已关闭");
    this.runtimeState = "starting";
    try {
      await Promise.all([mkdir(this.cwd, { recursive: true }), mkdir(this.sessionDir, { recursive: true })]);
      const resumeUnsaved = sessionPath && sameSessionPath(sessionPath, this.activeSessionPath) && !existsSync(sessionPath) && this.unsavedManager;
      if (sessionPath && !resumeUnsaved) await assertSessionPath(sessionPath, this.sessionDir);
      const { host, theme } = await this.createHost({
        cwd: this.cwd, agentDir: this.agentDir, sessionDir: this.sessionDir,
        sessionPath: resumeUnsaved ? null : sessionPath, sessionManager: resumeUnsaved || undefined, log: this.log,
      });
      this.host = host;
      this.unsavedManager = null;
      this.theme = theme;
      host.setBeforeSessionInvalidate(() => this.detachSession());
      host.setRebindSession(() => this.bindSession());
      if (this.closed) throw new Error("Windows Pi 运行时已关闭");
      if (this.stopRequests) throw busyError("Pi SDK启动已取消");
      await this.bindSession();
      if (this.closed) throw new Error("Windows Pi 运行时已关闭");
      this.runtimeState = "running";
      this.scheduleIdleTimer();
      this.emitEvent({ type: "runtime_ready", state: sessionState(host.session), idleTimeoutMs: this.idleTimeoutMs });
    } catch (error) {
      await this.performStop("startup_failure").catch((cleanupError) => this.log.error(`[pi-sdk] ${cleanupError.message}`));
      this.runtimeState = "error";
      this.emitEvent({ type: "runtime_exit", phase: "startup", error: error.message });
      throw error;
    }
  }

  async bindSession() {
    this.detachSession();
    const host = this.host;
    const session = host.session;
    this.activeSessionPath = session.sessionFile || null;
    this.messageRevision += 1;
    this.invalidateSession();
    this.uiBridge = createSdkUi({
      emit: (event) => { if (this.host === host && host.session === session) this.emitEvent(event); },
      theme: this.theme,
      onPendingChange: (count) => this.setBusy("extension-ui", count > 0),
    });
    this.unsubscribe = session.subscribe((event) => {
      if (this.host !== host || host.session !== session) return;
      this.trackAgentEvent(event);
      this.emitEvent(toBrowserAgentEvent(event));
    });
    await session.bindExtensions({
      uiContext: this.uiBridge.ui,
      // "rpc" describes the headless UI contract, not a subprocess transport.
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (options) => this.replaceFromExtension(host, () => host.newSession(options)),
        switchSession: async (file, options) => {
          const safePath = await assertSessionPath(file, this.sessionDir);
          const target = (await this.listSessions()).find((item) => sameSessionPath(item.path, safePath));
          if (!target || !sameSessionPath(target.cwd, this.cwd)) throw busyError("请通过工作台切换工作区");
          return this.replaceFromExtension(host, () => host.switchSession(safePath, options));
        },
        fork: async () => { throw new Error("工作台未启用会话分支"); },
        navigateTree: async () => { throw new Error("工作台未启用会话分支"); },
        reload: () => session.reload(),
      },
      shutdownHandler: () => { this.shutdownRequested = true; this.scheduleIdleTimer(); },
      onError: (error) => this.emitEvent({ type: "extension_error", extensionPath: error.extensionPath, event: error.event, error: error.error }),
    });
  }

  replaceFromExtension(host, operation) {
    if (this.closed || this.stopping || this.transitionCount) return Promise.reject(busyError());
    return this.enqueueTransition(() => this.replaceSessionInternal(host, operation));
  }

  async replaceSessionInternal(host, operation) {
    if (this.closed || this.stopping || this.host !== host) throw busyError();
    const previousPath = this.activeSessionPath;
    const previousManager = host.session.sessionManager;
    try {
      await host.session.settingsManager?.flush();
      const result = await operation();
      this.scheduleIdleTimer();
      if (result?.cancelled) return result;
      this.unsavedManager = null;
      this.activeSessionPath = host.session.sessionFile;
      this.emitEvent({ type: "runtime_ready", state: sessionState(host.session), idleTimeoutMs: this.idleTimeoutMs });
      return result;
    } catch (error) {
      // SDK replacement disposes the old session before creating the new one.
      // A failed factory must not leave a truthy but unusable host installed.
      this.detachSession();
      if (this.host === host) this.host = null;
      this.activeSessionPath = previousPath;
      this.unsavedManager = previousPath && !existsSync(previousPath) ? previousManager : null;
      clearTimeout(this.idleTimer);
      this.runtimeState = "error";
      await host.dispose().catch((disposeError) => this.log.error(`[pi-sdk] ${disposeError.message}`));
      this.emitEvent({ type: "runtime_exit", phase: "session_replace", error: error.message });
      throw error;
    }
  }

  detachSession() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.uiBridge?.close();
    this.uiBridge = null;
  }

  async send(command) {
    assertAllowedAgentCommand(command);
    // Dialog replies must be accepted even while session_start is awaiting UI.
    if (command.type === "extension_ui_response") return this.uiBridge?.respond(command) ?? null;
    if (this.transitionCount && !this.startPromise) throw busyError();
    await this.ensureStarted();
    if (this.closed || this.stopping || this.transitionCount) throw busyError();
    const session = this.host.session;
    const id = `sdk-${this.nextId++}`;
    let finishCommand;
    const done = new Promise((resolve) => { finishCommand = resolve; });
    this.pending.set(id, { type: command.type, done });
    if (ACTIVITY_COMMANDS.has(command.type)) this.setBusy(id, true);
    if (command.type === "abort") this.abortVersion += 1;
    try { return await dispatchSdkCommand(this, session, { ...command, id }); }
    finally {
      this.pending.delete(id);
      finishCommand();
      if (ACTIVITY_COMMANDS.has(command.type)) { this.messageRevision += 1; this.invalidateSession(); }
      if (this.busyReasons.has(id)) this.setBusy(id, false);
    }
  }

  async submitPrompt(session, command) {
    const version = this.abortVersion;
    const previous = this.promptAdmissionTail;
    let release;
    this.promptAdmissionTail = new Promise((resolve) => { release = resolve; });
    try {
      await previous;
      if (this.closed || this.stopping || this.host?.session !== session || version !== this.abortVersion) throw busyError("消息已取消或会话已切换");
      if (typeof command.message !== "string") throw new Error("消息必须是文字");
      if (session.isBashRunning) throw busyError("命令执行中，请等待完成后发送消息");
      let accept, reject, accepted = false;
      const admission = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
      const id = command.id;
      const run = Promise.resolve().then(() => session.prompt(command.message, {
        images: command.images, streamingBehavior: command.streamingBehavior, source: "rpc",
        preflightResult: (success) => { if (success) { accepted = true; accept(null); } },
      }));
      this.promptRuns.set(id, run);
      this.setBusy(`prompt:${id}`, true);
      void run.then(() => accept(null), (error) => {
        reject(error);
        if (accepted && !this.stopping && this.host?.session === session) {
          this.emitEvent({ type: "extension_error", event: "prompt", error: error.message || String(error) });
        }
      }).finally(() => {
        this.promptRuns.delete(id);
        this.invalidateSession(session.sessionFile);
        this.setBusy(`prompt:${id}`, false);
        if (this.host?.session === session && !this.promptRuns.size && !session.isStreaming && !session.isCompacting) {
          this.setBusy("agent", false);
          this.emitEvent({ type: "agent_settled" });
        }
      }).catch((error) => this.log.error(`[pi-sdk] ${error.message}`));
      return await admission;
    } finally { release(); }
  }

  updateProjectPrompt(save) {
    return this.enqueueTransition(async () => {
      this.assertMutable();
      const result = await save();
      if (!this.host) return { ...result, applied: true };
      try {
        await this.host.session.reload();
        this.snapshotEpoch += 1;
        this.emitEvent({ type: 'project_prompt_updated' });
        return { ...result, applied: true };
      } catch (error) {
        this.log.error(`[pi-sdk] 项目提示词重载失败：${error.message}`);
        await this.performStop('project-prompt-reload-failed').catch(() => {});
        return { ...result, applied: false, warning: '文件已保存，但当前会话重载失败，请重启工作台后再提问' };
      }
    });
  }

  newSession() {
    return this.enqueueTransition(async () => {
      this.assertMutable();
      await this.startInternal(null);
      return sessionState(this.host.session);
    });
  }
  async openSession(file) {
    const safePath = await assertSessionPath(file, this.sessionDir);
    return this.enqueueTransition(async () => {
      this.assertMutable();
      if (!this.host) await this.startInternal(safePath);
      else if (!sameSessionPath(safePath, this.activeSessionPath)) {
        const host = this.host;
        const result = await this.replaceSessionInternal(host, () => host.switchSession(safePath));
        if (result?.cancelled) throw busyError("会话切换已被扩展取消");
      }
      return sessionState(this.host.session);
    });
  }
  async renameSession(file, name) {
    const safePath = await assertSessionPath(file, this.sessionDir);
    const cleanName = String(name || "").trim();
    if (!cleanName || cleanName.length > 120) throw new Error("会话名称应为 1 至 120 个字符");
    return this.enqueueTransition(async () => {
      this.assertMutable();
      if (this.host && sameSessionPath(safePath, this.activeSessionPath)) this.host.session.setSessionName(cleanName);
      else await this.renameSaved(safePath, this.sessionDir, cleanName);
      this.invalidateSession(safePath);
      return { renamed: true, state: this.host ? sessionState(this.host.session) : null };
    });
  }
  async deleteSession(file) {
    const safePath = resolveSessionPath(file, this.sessionDir);
    if (existsSync(safePath)) await assertSessionPath(safePath, this.sessionDir);
    return this.enqueueTransition(async () => {
      this.assertMutable();
      const active = sameSessionPath(safePath, this.activeSessionPath);
      if (!existsSync(safePath) && !active) throw new Error("会话不存在");
      if (active) await this.startInternal(null);
      if (existsSync(safePath)) await unlink(safePath);
      this.invalidateSession(safePath);
      return { deleted: true, activeDeleted: active, state: active ? sessionState(this.host.session) : null };
    });
  }
  assertMutable() {
    if (this.closed) throw new Error("Windows Pi 运行时已关闭");
    if (this.stopping || this.isBusy() || this.pending.size) throw busyError("当前对话正在运行，请停止或等待完成后再操作");
  }

  emitEvent(event) {
    // A browser disconnect / consumer exception must not reject SDK execution.
    try { this.emit("event", event); }
    catch (error) { this.log.error(`[pi-sdk] 事件分发失败：${error.message}`); }
  }
  trackAgentEvent(event) {
    if (["message_start", "message_end", "agent_settled", "compaction_end"].includes(event.type) || (event.type === "message_update" && ["text_delta", "text_end", "toolcall_end"].includes(event.assistantMessageEvent?.type))) this.messageRevision += 1;
    if (["message_end", "agent_settled", "compaction_end"].includes(event.type)) this.invalidateSession();
    if (ACTIVITY_EVENTS.has(event.type)) this.scheduleIdleTimer();
    const reason = { agent_start: ["agent", true], agent_settled: ["agent", false], compaction_start: ["compaction", true], compaction_end: ["compaction", false], auto_retry_start: ["retry", true], auto_retry_end: ["retry", false] }[event.type];
    if (reason) this.setBusy(...reason);
  }
  setBusy(reason, busy) {
    if (busy) this.busyReasons.add(reason); else this.busyReasons.delete(reason);
    if (this.running && !this.stopping) this.scheduleIdleTimer();
  }
  scheduleIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.running || this.stopping || this.closed) return;
    this.idleTimer = setTimeout(() => void this.handleIdleTimeout().catch((error) => this.log.error(`[pi-sdk] ${error.message}`)), this.shutdownRequested ? 0 : this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }
  async handleIdleTimeout() {
    if (this.isBusy() || this.pending.size || this.transitionCount) {
      // A requested shutdown must not spin a zero-delay timer while busy.
      const requested = this.shutdownRequested;
      this.shutdownRequested = false;
      this.scheduleIdleTimer();
      this.shutdownRequested = requested;
      return;
    }
    return this.stop(this.shutdownRequested ? "extension" : "idle");
  }
  stop(reason = "manual") {
    this.stopRequests += 1;
    // Unblock a session_start dialog before waiting for the startup transition.
    this.uiBridge?.close();
    return this.enqueueTransition(async () => {
      try { return await this.performStop(reason); }
      finally { this.stopRequests -= 1; }
    });
  }
  close() { this.closed = true; return this.stop("shutdown"); }

  async performStop(reason) {
    if (this.cleanupPromise) return deadline(this.cleanupPromise, this.stopTimeoutMs);
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const host = this.host;
    if (!host) return;
    this.stopping = true;
    this.abortVersion += 1;
    this.runtimeState = "stopped";
    this.emitEvent({ type: "runtime_stopping", reason });
    this.uiBridge?.close();
    // An unpersisted empty/user-only session must survive an idle sleep too.
    const session = host.session;
    this.lastSessionState = sessionState(session);
    this.activeSessionPath = session.sessionFile || this.activeSessionPath;
    this.unsavedManager = this.activeSessionPath && !existsSync(this.activeSessionPath) ? session.sessionManager : null;
    const cleanup = (async () => {
      try {
        session.clearQueue(); session.abortCompaction(); session.abortBash(); session.abortRetry();
        await session.abort();
        await Promise.allSettled([...this.promptRuns.values(), ...[...this.pending.values()].map((item) => item.done)]);
      } finally {
        try { await host.dispose(); }
        finally {
          // SDK dispose is idempotent; ensure invalidation even if an extension
          // shutdown hook rejects before AgentSessionRuntime reaches dispose.
          try { session.dispose(); }
          finally {
            await session.settingsManager?.flush().catch((error) => this.log.error(`[pi-sdk] 保存设置失败：${error.message}`));
            if (this.activeSessionPath && existsSync(this.activeSessionPath)) this.unsavedManager = null;
            this.invalidateSession();
            this.detachSession();
            if (this.host === host) this.host = null;
            this.promptRuns.clear(); this.busyReasons.clear();
            this.stopping = false; this.shutdownRequested = false;
            this.runtimeState = reason === "idle" ? "idle" : "stopped";
            this.emitEvent({ type: reason === "idle" ? "runtime_idle" : "runtime_stopped", reason, idleTimeoutMs: this.idleTimeoutMs });
          }
        }
      }
    })();
    this.cleanupPromise = cleanup;
    void cleanup.finally(() => { if (this.cleanupPromise === cleanup) this.cleanupPromise = null; }).catch((error) => this.log.error(`[pi-sdk] 清理失败：${error.message}`));
    try { await deadline(cleanup, this.stopTimeoutMs); }
    catch (error) {
      // Do not create another Agent on timeout. The old one stays quarantined
      // until cooperative cleanup finishes; SDK tasks cannot be killed in-process.
      this.runtimeState = "error";
      this.emitEvent({ type: "runtime_exit", phase: "cleanup", error: error.message });
      throw error;
    }
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
function deadline(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Pi SDK清理超时，请等待任务退出；持续无响应时重启工作台")), ms);
  })]).finally(() => clearTimeout(timer));
}
