import { TaskStore } from './domain/task-store.mjs';
import { launchWorkApps } from './domain/launch-work-apps.mjs';
import { fault } from '../shared/errors.js';
import { prepareWorkspace } from './domain/workspace-layout.mjs';
import { validateWorkspaceSettings } from './domain/workspace-resources.mjs';
import { WorkApps } from './domain/work-apps.mjs';
import { saveProjectPrompt } from './domain/project-prompt.mjs';
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildDashboard, buildDayDetails, localDateString } from "./domain/tasks.mjs";
import { DailyRecordManager } from "./domain/daily-record-manager.mjs";
import { PiSdkRuntime } from "./domain/pi-sdk.mjs";
import { PiAdmin } from "./domain/pi-admin.mjs";
import { SkillManager } from "./domain/skill-manager.mjs";
import { VSkillManager } from "./domain/vskill-manager.mjs";
import { WorkspaceService } from "./domain/workspace.mjs";
import { WorkspaceRegistry, samePath } from "./domain/workspace-registry.mjs";
import { publicErrorMessage } from "../shared/errors.js";
import { PromptReceipts } from "./prompt-receipts.mjs";
import { UiEventPayloads } from './ui-event-payloads.mjs';
import { boundBrowserAgentEvent, MAX_BROWSER_EVENT_BYTES } from './domain/pi-sdk-ui.mjs';
import { enqueueWorkspaceOperation, assertWorkspaceSnapshot } from './workspace-operations.mjs';

import { WorkDocuments } from './domain/work-documents.mjs';

export async function createRuntimeContext(config) {
  const context = new RuntimeContext(config);
  await context.initialize();
  return context;
}

class RuntimeContext {
  constructor(config) {
    this.config = config;
    this.workDocuments = new WorkDocuments({ filePath: config.workDocumentsFile || path.join(path.dirname(config.todoFile), 'work-documents.json') });
    this.workApps = new WorkApps({ filePath: config.workAppsFile || path.join(path.dirname(config.todoFile), 'work-apps.json'), launch: apps => launchWorkApps(apps, { appScript: config.appScript }) });
    this.taskStore = new TaskStore({ todoFile: config.todoFile, backupDir: config.backupDir });
    this.workspaceSwitchQueue = Promise.resolve();
    this.workspaceEpoch = 0;
    this.workspaceSwitching = false;
    this.switchCandidateRuntime = null;
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.emitEvent = config.emitEvent || (() => {});
    this.uiEventPayloads = new UiEventPayloads({ onFailure: event => this.emitAgentEvent(event) });
    this.promptReceipts = new PromptReceipts();
    this.activeAuthLoginAbort = null;
    this.authLoginSequence = 0;
    this.toolCalls = new Map();
    this.turnFileEpoch = 0;
    this.turnFiles = { involved: new Set(), modified: new Set() };
    this.vskillManager = new VSkillManager({ filePath: config.vskillFile, backupDir: config.backupDir });
    this.dailyRecordManager = new DailyRecordManager({ filePath: config.dailyRecordFile, backupDir: config.backupDir });
    this.workspaceRegistry = new WorkspaceRegistry({ filePath: config.workspaceFile, backupDir: config.backupDir, defaultRoot: config.workspaceDir, log: console });
  }

  async initialize() {
    await Promise.all([
      mkdir(this.config.backupDir, { recursive: true }),
      this.vskillManager.initialize(),
      this.dailyRecordManager.initialize(),
      this.workspaceRegistry.initialize(),
    ]);
    this.activeWorkspace = this.workspaceRegistry.active();
    Object.assign(this, await this.createRuntimeServices(this.activeWorkspace.canonicalRoot));
  }

  async createRuntimeServices(cwd) {
    const workspaceLayout = await prepareWorkspace(cwd);
    validateWorkspaceSettings(workspaceLayout.workspaceRoot);
    const runtime = new PiSdkRuntime({
      cwd, sessionDir: this.config.piSessionDir, agentDir: this.config.piAgentDir, log: console,
      dataPaths: { todoFile: this.config.todoFile, dailyRecordFile: this.config.dailyRecordFile },
    });
    const admin = new PiAdmin({ agentDir: this.config.piAgentDir, cwd, piRuntime: runtime, log: console });
    const skills = new SkillManager({ agentDir: this.config.piAgentDir, cwd, backupDir: this.config.backupDir, piAdmin: admin, log: console });
    const files = await new WorkspaceService(cwd).initialize();
    runtime.on("event", (event) => {
      if (runtime === this.piRuntime) this.broadcastAgentEvent(event);
      else if (runtime === this.switchCandidateRuntime && event.type === "extension_ui_request") this.emitAgentEvent(event);
    });
    return { piRuntime: runtime, piAdmin: admin, skillManager: skills, workspaceService: files, workspaceLayout };
  }

  async ensureActiveStarted(snapshot) {
    assertWorkspaceSnapshot(this, snapshot);
    const { runtime, workspace } = snapshot;
    if (runtime.running || runtime.activeSessionPath) return runtime.ensureStarted();
    const sessions = await this.listActiveSessions(runtime, workspace);
    assertWorkspaceSnapshot(this, snapshot);
    const remembered = sessions.find((session) => session.id === workspace.lastSessionId);
    return remembered ? runtime.openSession(remembered.path) : runtime.ensureStarted();
  }

  async listActiveSessions(runtime = this.piRuntime, workspace = this.activeWorkspace) {
    return (await runtime.listSessions()).filter((session) => session.cwd && samePath(session.cwd, workspace.canonicalRoot));
  }

  async assertSessionInActiveWorkspace(sessionPath, runtime = this.piRuntime, workspace = this.activeWorkspace) {
    const session = (await this.listActiveSessions(runtime, workspace)).find((entry) => samePath(entry.path, sessionPath));
    if (!session) throw fault(403, "该会话不属于当前工作区");
    return session;
  }

  assertActiveWorkspace(workspaceId) {
    if (workspaceId && workspaceId !== this.activeWorkspace.id) throw fault(409, "工作区已切换，请刷新后重试");
  }

  publicWorkspace(item) {
    return { id: item.id, name: item.name, root: item.root, isDefault: Boolean(item.isDefault), available: item.available !== false, lastUsedAt: item.lastUsedAt };
  }

  async publicWorkspaceList() {
    const listed = await this.workspaceRegistry.list();
    return { activeWorkspaceId: listed.activeWorkspaceId, items: listed.items.map((item) => this.publicWorkspace(item)), warning: this.workspaceRegistry.fallbackWarning };
  }

  async rememberSessionFromState(state, snapshot) {
    assertWorkspaceSnapshot(this, snapshot);
    if (!state?.sessionId) return;
    await this.workspaceRegistry.rememberSession(snapshot.workspace.id, state.sessionId);
    this.activeWorkspace = this.workspaceRegistry.active();
  }

  saveProjectPrompt(body) {
    const operation = async () => {
      if (!body.workspaceId) throw fault(400, '缺少项目标识');
      this.assertActiveWorkspace(body.workspaceId);
      if (this.shuttingDown || this.piAdmin.maintenanceActive) throw fault(409, '工作台正在维护，请稍后重试');
      const root = this.workspaceService.rootReal;
      return this.piRuntime.updateProjectPrompt(async () => ({
        ...await saveProjectPrompt(root, body, this.config.backupDir), workspaceId: body.workspaceId,
      }));
    };
    return enqueueWorkspaceOperation(this, operation);
  }

  activateWorkspace(id) {
    const operation = async () => {
      const target = await this.workspaceRegistry.validateRegistered(id);
      validateWorkspaceSettings(target.canonicalRoot);
      if (id === this.activeWorkspace.id) return { workspace: this.publicWorkspace(this.activeWorkspace), sessions: await this.listActiveSessions() };
      if (this.piRuntime.state === "busy" || this.piRuntime.busyReasons.size || this.piRuntime.pending.size || this.piAdmin.maintenanceActive) throw fault(409, "任务完成后再切换工作区");
      const previousWorkspace = this.activeWorkspace;
      const previousSessionPath = this.piRuntime.activeSessionPath;
      const previous = { piRuntime: this.piRuntime, piAdmin: this.piAdmin };
      let candidate = null;
      this.workspaceSwitching = true;
      this.workspaceEpoch += 1;
      this.uiEventPayloads.clear();
      try {
        await previous.piRuntime.close();
        previous.piAdmin.close();
        if (this.shuttingDown) throw fault(503, "工作台正在退出");
        candidate = await this.createRuntimeServices(target.canonicalRoot);
        this.switchCandidateRuntime = candidate.piRuntime;
        if (this.shuttingDown) throw fault(503, "工作台正在退出");
        const sessions = await this.listActiveSessions(candidate.piRuntime, target);
        const remembered = sessions.find((session) => session.id === target.lastSessionId);
        if (remembered) await candidate.piRuntime.openSession(remembered.path);
        else await candidate.piRuntime.ensureStarted();
        const state = await candidate.piRuntime.send({ type: "get_state" });
        const committed = await this.workspaceRegistry.setActive(target.id, state?.sessionId || target.lastSessionId || null);
        Object.assign(this, candidate);
        this.activeWorkspace = committed;
        this.clearTurnFiles();
        this.emitAgentEvent({ type: "workspace_changed", workspace: this.publicWorkspace(this.activeWorkspace) });
        return { workspace: this.publicWorkspace(this.activeWorkspace), sessions, state };
      } catch (error) {
        candidate?.piAdmin?.close();
        await candidate?.piRuntime?.close().catch(() => {});
        if (this.shuttingDown) throw error;
        // A timed-out in-process Agent cannot be killed like the old child.
        // Never start a rollback Agent while either runtime still owns resources.
        if (previous.piRuntime.running || candidate?.piRuntime?.running) {
          if (candidate?.piRuntime?.running) Object.assign(this, candidate);
          throw fault(500, `Pi SDK资源仍未释放，无法安全回滚；请重启工作台。${error.message}`);
        }
        const rollback = await this.createRuntimeServices(previousWorkspace.canonicalRoot);
        this.switchCandidateRuntime = rollback.piRuntime;
        let rollbackState = null;
        try {
          if (previousSessionPath && existsSync(previousSessionPath)) rollbackState = await rollback.piRuntime.openSession(previousSessionPath);
          else {
            await rollback.piRuntime.ensureStarted();
            rollbackState = await rollback.piRuntime.send({ type: "get_state" });
          }
        } catch (rollbackError) { console.error(`工作区回滚失败：${rollbackError.message}`); }
        Object.assign(this, rollback);
        this.activeWorkspace = this.workspaceRegistry.active();
        if (rollbackState) this.emitAgentEvent({ type: "runtime_ready", state: rollbackState, restored: true });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
      } finally { this.workspaceSwitching = false; this.switchCandidateRuntime = null; }
    };
    return enqueueWorkspaceOperation(this, operation);
  }

  async safeAgentCommand(command, fallback, runtime = this.piRuntime) {
    try { return await runtime.send(command); }
    catch (error) { console.warn(`${command.type} 获取失败：`, error.message); return fallback; }
  }

  startAuthLogin(providerId, subscriptionId) {
    const abort = new AbortController();
    const sequence = ++this.authLoginSequence;
    this.activeAuthLoginAbort?.abort(new Error("已切换登录"));
    this.activeAuthLoginAbort = abort;
    this.authSubscriptionId = subscriptionId;
    const emit = event => this.emitEvent("auth", { subscriptionId, ...event });
    void (async () => {
      try {
        await this.piAdmin.cancelOAuthLogins();
        if (abort.signal.aborted || sequence !== this.authLoginSequence) return;
        await this.piAdmin.loginOAuth(providerId, { signal: abort.signal, emit });
      } catch (error) { emit({ type: abort.signal.aborted ? "cancelled" : "error", message: publicErrorMessage(error) }); }
      finally { if (this.activeAuthLoginAbort === abort) this.activeAuthLoginAbort = null; }
    })();
    return { ok: true };
  }

  agentConnection() {
    const runtime = this.switchCandidateRuntime || this.piRuntime;
    return [
      { type: "connected", running: this.piRuntime.running, state: this.piRuntime.state, idleTimeoutMs: this.piRuntime.idleTimeoutMs, workspace: this.publicWorkspace(this.activeWorkspace) },
      ...runtime.pendingUiRequests().map(event => this.prepareAgentEvent(event)),
    ];
  }

  broadcastAgentEvent(event) {
    if (event.type === "agent_start") {
      this.clearTurnFiles();
    }
    this.emitAgentEvent(event);
    if (event.type === "tool_execution_start") void this.trackWorkspaceTool(event);
    if (event.type === "tool_execution_end") {
      const call = this.toolCalls.get(event.toolCallId);
      if (call) { call.success = event.isError === false; this.confirmWorkspaceTool(event.toolCallId, call); }
    }
    if (["runtime_stopping", "runtime_exit"].includes(event.type)) { this.turnFileEpoch += 1; this.toolCalls.clear(); this.uiEventPayloads.clear(); }
    if (event.type === "agent_settled") {
      for (const [id, call] of this.toolCalls) if (call.success === undefined) this.toolCalls.delete(id);
    }
  }

  prepareAgentEvent(event) {
    if (event.type === 'extension_ui_request' && Buffer.byteLength(JSON.stringify(event)) > MAX_BROWSER_EVENT_BYTES) {
      const runtime = this.switchCandidateRuntime || this.piRuntime;
      return this.uiEventPayloads.put(event, runtime, this.workspaceEpoch, this.activeWorkspace.id);
    }
    return boundBrowserAgentEvent(event);
  }

  emitAgentEvent(event) { this.emitEvent("agent", this.prepareAgentEvent(event)); }

  async trackWorkspaceTool(event) {
    const toolName = String(event.toolName || "").toLowerCase();
    if (!["read", "edit", "write"].includes(toolName)) return;
    const rawPath = event.args?.path ?? event.args?.file_path ?? event.args?.filePath;
    const id = event.toolCallId;
    if (!id) return;
    const call = { epoch: this.turnFileEpoch, workspace: this.workspaceService, writes: ["edit", "write"].includes(toolName) };
    this.toolCalls.set(id, call);
    const relative = await call.workspace.normalizeToolPath(rawPath).catch(() => null);
    if (call.epoch !== this.turnFileEpoch || call.workspace !== this.workspaceService || this.toolCalls.get(id) !== call) return;
    if (!relative || /^BaodanPark(?:[\\/]|$)/i.test(relative)) { this.toolCalls.delete(id); return; }
    call.relative = relative;
    this.turnFiles.involved.add(relative);
    this.confirmWorkspaceTool(id, call);
    this.emitAgentEvent({ type: "workspace_turn_files", ...this.turnFileSnapshot() });
  }

  confirmWorkspaceTool(id, call) {
    if (!call.relative || call.success === undefined) return;
    this.toolCalls.delete(id);
    if (call.success && call.writes) {
      this.turnFiles.modified.add(call.relative);
      this.emitAgentEvent({ type: "workspace_turn_files", ...this.turnFileSnapshot() });
    }
  }

  turnFileSnapshot() { return { involved: [...this.turnFiles.involved], modified: [...this.turnFiles.modified] }; }
  clearTurnFiles() { this.turnFileEpoch += 1; this.toolCalls.clear(); this.turnFiles.involved.clear(); this.turnFiles.modified.clear(); this.emitAgentEvent({ type: "workspace_turn_files", ...this.turnFileSnapshot() }); }

  dashboard(tasks, month) { return buildDashboard(tasks, { month }); }
  dayDetails(tasks, date) { return buildDayDetails(tasks, date); }
  today() { return localDateString(); }

  beginShutdown() {
    if (this.quiescePromise) return this.quiescePromise;
    this.shuttingDown = true;
    this.uiEventPayloads.clear();
    this.activeAuthLoginAbort?.abort();
    this.piAdmin.close();
    const runtimes = new Set([this.piRuntime, this.switchCandidateRuntime].filter(Boolean));
    this.quiescePromise = Promise.allSettled([...runtimes].map(runtime => runtime.beginShutdown?.()));
    return this.quiescePromise;
  }

  shutdown(requests = []) {
    if (this.shutdownPromise) return this.shutdownPromise;
    const interrupted = this.beginShutdown();
    for (const request of requests) request.controller?.abort();
    this.shutdownPromise = (async () => {
      // Release interactive/model waits before draining accepted requests.
      // Keep the runtime alive until their persistent writes have finished.
      await Promise.allSettled([interrupted, ...requests.map(request => request.task)]);
      await Promise.allSettled([this.taskStore.whenIdle(), this.workspaceSwitchQueue]);
      const runtimes = new Set([this.piRuntime, this.switchCandidateRuntime].filter(Boolean));
      await Promise.allSettled([...runtimes].map(runtime => runtime.close()));
    })();
    return this.shutdownPromise;
  }
}
