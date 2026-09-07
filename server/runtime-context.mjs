import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildDashboard, buildDayDetails, localDateString, parseWorkTodo } from "../lib/tasks.mjs";
import { DailyRecordManager } from "../lib/daily-record-manager.mjs";
import { PiRpcRuntime } from "../lib/pi-rpc.mjs";
import { addTaskMarkdown, deleteTaskMarkdown, moveTaskDateMarkdown, mutationError, updateTaskMarkdown } from "../lib/task-writer.mjs";
import { PiAdmin } from "../lib/pi-admin.mjs";
import { SkillManager } from "../lib/skill-manager.mjs";
import { VSkillManager } from "../lib/vskill-manager.mjs";
import { WorkspaceService } from "../lib/workspace.mjs";
import { WorkspaceRegistry, samePath } from "../lib/workspace-registry.mjs";
import { publicErrorMessage } from "./response.mjs";

const execFileAsync = promisify(execFile);

export async function createRuntimeContext(config) {
  const context = new RuntimeContext(config);
  await context.initialize();
  return context;
}

class RuntimeContext {
  constructor(config) {
    this.config = config;
    this.lastGoodSource = null;
    this.taskMutationQueue = Promise.resolve();
    this.workspaceSwitchQueue = Promise.resolve();
    this.workspaceSwitching = false;
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.eventClients = new Set();
    this.activeAuthLoginAbort = null;
    this.authLoginSequence = 0;
    this.turnFiles = { involved: new Set(), modified: new Set() };
    this.server = null;
    this.vskillManager = new VSkillManager({ filePath: config.vskillFile, backupDir: config.backupDir });
    this.dailyRecordManager = new DailyRecordManager({ filePath: config.dailyRecordFile, backupDir: config.backupDir });
    this.workspaceRegistry = new WorkspaceRegistry({ filePath: config.workspaceFile, backupDir: config.backupDir, defaultRoot: config.workspaceDir, log: console });
  }

  async initialize() {
    await Promise.all([
      mkdir(this.config.backupDir, { recursive: true }),
      mkdir(this.config.workspaceDir, { recursive: true }),
      this.vskillManager.initialize(),
      this.dailyRecordManager.initialize(),
      this.workspaceRegistry.initialize(),
    ]);
    await this.migrateCoreSkill();
    this.activeWorkspace = this.workspaceRegistry.active();
    Object.assign(this, await this.createRuntimeServices(this.activeWorkspace.canonicalRoot));
  }

  attachServer(server) { this.server = server; }

  async createRuntimeServices(cwd) {
    const runtime = new PiRpcRuntime({ cwd, sessionDir: this.config.piSessionDir, agentDir: this.config.piAgentDir, log: console });
    const admin = new PiAdmin({ agentDir: this.config.piAgentDir, cwd, piRuntime: runtime, log: console });
    const skills = new SkillManager({ agentDir: this.config.piAgentDir, cwd, backupDir: this.config.backupDir, piAdmin: admin, log: console });
    const files = await new WorkspaceService(cwd).initialize();
    runtime.on("event", (event) => { if (runtime === this.piRuntime) this.broadcastAgentEvent(event); });
    return { piRuntime: runtime, piAdmin: admin, skillManager: skills, workspaceService: files };
  }

  async migrateCoreSkill() {
    const source = path.join(this.config.workspaceDir, ".pi", "skills", "ultimate-workhorse");
    const target = path.join(this.config.piAgentDir, "skills", "ultimate-workhorse");
    if (!existsSync(source) || existsSync(target)) return;
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { recursive: true, errorOnExist: true });
      console.log(`核心Skill已共享到全局目录：${target}`);
    } catch (error) {
      console.warn(`共享核心Skill失败，将继续使用项目副本：${error.message}`);
    }
  }

  async ensureActiveStarted() {
    if (this.piRuntime.running || this.piRuntime.activeSessionPath) return this.piRuntime.ensureStarted();
    const sessions = await this.listActiveSessions();
    const remembered = sessions.find((session) => session.id === this.activeWorkspace.lastSessionId);
    return remembered ? this.piRuntime.openSession(remembered.path) : this.piRuntime.ensureStarted();
  }

  async listActiveSessions(runtime = this.piRuntime, workspace = this.activeWorkspace) {
    return (await runtime.listSessions()).filter((session) => session.cwd && samePath(session.cwd, workspace.canonicalRoot));
  }

  async assertSessionInActiveWorkspace(sessionPath) {
    const session = (await this.listActiveSessions()).find((entry) => samePath(entry.path, sessionPath));
    if (!session) throw mutationError(403, "该会话不属于当前工作区");
    return session;
  }

  assertActiveWorkspace(workspaceId) {
    if (workspaceId && workspaceId !== this.activeWorkspace.id) throw mutationError(409, "工作区已切换，请刷新后重试");
  }

  publicWorkspace(item) {
    return { id: item.id, name: item.name, root: item.root, isDefault: Boolean(item.isDefault), available: item.available !== false, lastUsedAt: item.lastUsedAt };
  }

  async publicWorkspaceList() {
    const listed = await this.workspaceRegistry.list();
    return { activeWorkspaceId: listed.activeWorkspaceId, items: listed.items.map((item) => this.publicWorkspace(item)), warning: this.workspaceRegistry.fallbackWarning };
  }

  async rememberSessionFromState(state) {
    if (!state?.sessionId) return;
    await this.workspaceRegistry.rememberSession(this.activeWorkspace.id, state.sessionId);
    this.activeWorkspace = this.workspaceRegistry.active();
  }

  activateWorkspace(id) {
    const operation = async () => {
      if (id === this.activeWorkspace.id) return { workspace: this.publicWorkspace(this.activeWorkspace), sessions: await this.listActiveSessions() };
      if (this.piRuntime.state === "busy" || this.piRuntime.busyReasons.size || this.piRuntime.pending.size || this.piAdmin.maintenanceActive) throw mutationError(409, "任务完成后再切换工作区");
      const target = await this.workspaceRegistry.validateRegistered(id);
      const previousWorkspace = this.activeWorkspace;
      const previousSessionPath = this.piRuntime.activeSessionPath;
      const previous = { piRuntime: this.piRuntime, piAdmin: this.piAdmin };
      let candidate = null;
      this.workspaceSwitching = true;
      try {
        await previous.piRuntime.close();
        previous.piAdmin.close();
        candidate = await this.createRuntimeServices(target.canonicalRoot);
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
        const rollback = await this.createRuntimeServices(previousWorkspace.canonicalRoot);
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
      } finally { this.workspaceSwitching = false; }
    };
    const queued = this.workspaceSwitchQueue.then(operation);
    this.workspaceSwitchQueue = queued.catch(() => {});
    return queued;
  }

  async safeAgentCommand(command, fallback) {
    try { return await this.piRuntime.send(command); }
    catch (error) { console.warn(`${command.type} 获取失败：`, error.message); return fallback; }
  }

  openAuthLoginStream(req, res, providerId) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const previousAbort = this.activeAuthLoginAbort;
    const abort = new AbortController();
    const sequence = ++this.authLoginSequence;
    this.activeAuthLoginAbort = abort;
    previousAbort?.abort(new Error("已切换到其他供应商登录"));
    let ended = false;
    const emit = (event) => { if (!ended && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    res.on("close", () => abort.abort(new Error("登录连接已关闭")));
    void (async () => {
      try {
        await this.piAdmin.cancelOAuthLogins();
        if (abort.signal.aborted || sequence !== this.authLoginSequence) return;
        await this.piAdmin.loginOAuth(providerId, { signal: abort.signal, emit });
      } catch (error) {
        emit({ type: abort.signal.aborted ? "cancelled" : "error", message: publicErrorMessage(error) });
      } finally {
        ended = true;
        if (this.activeAuthLoginAbort === abort) this.activeAuthLoginAbort = null;
        if (!res.destroyed) res.end();
      }
    })();
  }

  openAgentEventStream(req, res) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`data: ${JSON.stringify({ type: "connected", running: this.piRuntime.running, state: this.piRuntime.state, idleTimeoutMs: this.piRuntime.idleTimeoutMs, workspace: this.publicWorkspace(this.activeWorkspace) })}\n\n`);
    this.eventClients.add(res);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); }, 30_000);
    const cleanup = () => { clearInterval(heartbeat); this.eventClients.delete(res); };
    req.on("close", cleanup); res.on("close", cleanup);
  }

  broadcastAgentEvent(event) {
    if (event.type === "agent_start") {
      this.turnFiles.involved.clear(); this.turnFiles.modified.clear();
      this.emitAgentEvent({ type: "workspace_turn_files", ...this.turnFileSnapshot() });
    }
    this.emitAgentEvent(event);
    if (event.type === "tool_execution_start") void this.trackWorkspaceTool(event);
  }

  emitAgentEvent(event) {
    const encoded = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.eventClients) {
      if (client.destroyed) this.eventClients.delete(client); else client.write(encoded);
    }
  }

  async trackWorkspaceTool(event) {
    const toolName = String(event.toolName || "").toLowerCase();
    if (!["read", "edit", "write"].includes(toolName)) return;
    const rawPath = event.args?.path ?? event.args?.file_path ?? event.args?.filePath;
    const relative = await this.workspaceService.normalizeToolPath(rawPath).catch(() => null);
    if (!relative) return;
    this.turnFiles.involved.add(relative);
    if (["edit", "write"].includes(toolName)) this.turnFiles.modified.add(relative);
    this.emitAgentEvent({ type: "workspace_turn_files", ...this.turnFileSnapshot() });
  }

  turnFileSnapshot() { return { involved: [...this.turnFiles.involved], modified: [...this.turnFiles.modified] }; }
  clearTurnFiles() { this.turnFiles.involved.clear(); this.turnFiles.modified.clear(); this.emitAgentEvent({ type: "workspace_turn_files", ...this.turnFileSnapshot() }); }

  async loadTasks() {
    try {
      const [content, fileStat] = await Promise.all([readFile(this.config.todoFile, "utf8"), stat(this.config.todoFile)]);
      const result = { tasks: parseWorkTodo(content), updatedAt: fileStat.mtime.toISOString(), stale: false, warning: null };
      this.lastGoodSource = result;
      return result;
    } catch (error) {
      if (this.lastGoodSource) return { ...this.lastGoodSource, stale: true, warning: `读取最新待办失败，当前展示上次数据：${error.message}` };
      throw mutationError(500, `无法读取工作待办：${error.message}`);
    }
  }

  dashboard(tasks, month) { return buildDashboard(tasks, { month }); }
  dayDetails(tasks, date) { return buildDayDetails(tasks, date); }
  today() { return localDateString(); }

  mutateTask(kind, revision, taskId, body) {
    const transforms = {
      create: (content) => addTaskMarkdown(content, body, localDateString()),
      update: (content) => updateTaskMarkdown(content, taskId, body, localDateString()),
      move: (content) => moveTaskDateMarkdown(content, taskId, body.sourceDate, body.targetDate),
      delete: (content) => deleteTaskMarkdown(content, taskId),
    };
    return this.mutateTodoFile(revision, transforms[kind]);
  }

  async mutateTodoFile(revision, transform) {
    const operation = async () => {
      const [original, fileStat] = await Promise.all([readFile(this.config.todoFile, "utf8"), stat(this.config.todoFile)]);
      const currentRevision = fileStat.mtime.toISOString();
      if (!revision) throw mutationError(400, "缺少源文件版本，请刷新页面后重试");
      if (revision !== currentRevision) throw mutationError(409, "工作待办已在其他位置更新，请刷新后重新操作");
      const nextContent = transform(original);
      if (nextContent === original) return { updatedAt: currentRevision };
      await this.persistTodoFile(original, nextContent);
      const nextStat = await stat(this.config.todoFile);
      this.lastGoodSource = { tasks: parseWorkTodo(nextContent), updatedAt: nextStat.mtime.toISOString(), stale: false, warning: null };
      return { updatedAt: nextStat.mtime.toISOString() };
    };
    const queued = this.taskMutationQueue.then(operation);
    this.taskMutationQueue = queued.catch(() => {});
    return queued;
  }

  async persistTodoFile(original, nextContent) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(this.config.backupDir, `工作待办-${stamp}.md`);
    const tempPath = `${this.config.todoFile}.super-baodan-${process.pid}-${Date.now()}.tmp`;
    await writeFile(backupPath, original, "utf8");
    try { await writeFile(tempPath, nextContent, "utf8"); await rename(tempPath, this.config.todoFile); }
    catch (error) { await unlink(tempPath).catch(() => {}); throw mutationError(500, `写入工作待办失败，原文件已备份：${error.message}`); }
    this.trimTaskBackups().catch((error) => console.warn("清理待办备份失败：", error.message));
  }

  async trimTaskBackups() {
    const files = (await readdir(this.config.backupDir)).filter((name) => name.startsWith("工作待办-") && name.endsWith(".md")).sort().reverse();
    await Promise.all(files.slice(30).map((name) => unlink(path.join(this.config.backupDir, name)).catch(() => {})));
  }

  async openWorkApps() {
    const { stdout, stderr } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.config.appScript], { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true });
    const output = stdout.trim();
    const start = output.lastIndexOf("[");
    return { results: JSON.parse(start >= 0 ? output.slice(start) : output), warning: stderr.trim() || null };
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      for (const client of this.eventClients) client.end();
      this.eventClients.clear();
      this.server?.close(); this.server?.closeIdleConnections?.();
      this.piAdmin.close();
      await this.piRuntime.close().catch(() => {});
      process.exit(0);
    })();
    setTimeout(() => process.exit(0), 7000).unref();
    return this.shutdownPromise;
  }
}
