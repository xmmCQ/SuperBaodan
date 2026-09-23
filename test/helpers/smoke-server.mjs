import http from "node:http";
import { buildDashboard, buildDayDetails } from '../../app/services/domain/tasks.mjs';
import { taskKind, validateTaskTimes } from '../../app/shared/task-fields.js';
import { listenOnSafePort } from './listen.mjs';
import { WorkApps } from '../../app/services/domain/work-apps.mjs';
import { WorkDocuments } from '../../app/services/domain/work-documents.mjs';
import { readProjectPrompt, saveProjectPrompt } from '../../app/services/domain/project-prompt.mjs';
import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTempProject } from "./temp-project.mjs";

// UI scenario fixture only: deterministic in-memory task/agent responses.
// Persistence, locking, cancellation and path safety belong to real service tests.
// smoke-contract.test.mjs checks the supported request/response boundary.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TODAY = "2026-09-04";

export async function createSmokeServer({ appRoot = path.join(ROOT, 'app') } = {}) {
  const temp = await createTempProject("super-baodan-browser-smoke-");
  const state = {
    revision: 1,
    projectRoot: temp.root,
    appRoot: path.resolve(appRoot),
    tasks: [],
    dailyRecords: [],
    holidays: {},
    recordSequence: 0,
    files: new Map(),
    operations: [],
    sessionSettings: new Map(),
    sessions: [session("seed", "已有对话")],
    activeSessionId: "seed",
    messages: new Map([["seed", [
      { role: "user", content: "历史问题" },
      { role: "assistant", content: [{ type: "text", text: "已恢复的历史回复" }] },
    ]]]),
    eventClients: new Set(),
  };
  state.workApps = new WorkApps({ filePath: temp.resolve('work-apps.json'), defaults: [{ id: 'fixture', name: '测试软件', path: 'C:\\Apps\\Test.exe', enabled: true, processes: [] }], launch: async apps => { state.operations.push(...apps.map(app => `app:open:${app.id}`)); return { results: apps.map(app => ({ name: app.name, status: 'started', message: '已发送启动请求' })) }; } });
  state.documentRequests = [];
  state.workDocuments = new WorkDocuments({ filePath: temp.resolve('work-documents.json'), pick: async () => ({ cancelled: true }), recycle: async file => { await rename(file, temp.resolve(`recycled-${path.basename(file)}`)); state.operations.push(`document:recycle:${file}`); }, launch: async file => { state.operations.push(`document:open:${file}`); } });
  state.workDocuments.pick = async () => ({ cancelled: true });
  const server = http.createServer((req, res) => void handle(req, res, state));
  await listenOnSafePort(server);
  return {
    port: server.address().port,
    state,
    root: temp.root,
    async close() {
      for (const client of state.eventClients) client.end();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      await temp.cleanup();
    },
  };
}

async function handle(req, res, state) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const modelCommand = ({'GET /api/models/catalog':'models.catalog','POST /api/models/catalog/refresh':'models.refresh','PUT /api/models/preferences/display':'models.saveDisplay','PUT /api/models/preferences/defaults':'models.saveDefaults'})[`${req.method} ${url.pathname}`];
    if (modelCommand && state.modelCommand) return json(res,200,await state.modelCommand(modelCommand,await readJson(req)));
    if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, assistantInstalled: true, assistantRunning: true, assistantState: "running", workspace: workspace(), today: TODAY });
    if (req.method === 'GET' && url.pathname === '/api/holidays') {
      const year = Number(url.searchParams.get('year'));
      return json(res, 200, state.holidays[year] || { year, region: 'CN', status: 'available', dates: [], source: 'fixture', fetchedAt: '2026-09-04T00:00:00Z', stale: false, warning: null });
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard") return json(res, 200, dashboard(state));
    const day = url.pathname.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/);
    if (req.method === "GET" && day) return json(res, 200, dayDetails(state, day[1]));
    if (req.method === "POST" && url.pathname === "/api/tasks") return await createTask(req, res, state);
    const move = url.pathname.match(/^\/api\/tasks\/([^/]+)\/move$/);
    if (req.method === "PATCH" && move) return await moveTask(req, res, state, move[1]);
    const task = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (req.method === "PATCH" && task) return await updateTask(req, res, state, task[1]);
    if (req.method === "DELETE" && task) return await deleteTask(req, res, state, task[1]);

    if (req.method === "GET" && url.pathname === "/api/daily-records") return json(res, 200, { records: dailyRecordsForDate(state, url.searchParams.get("date")) });
    if (req.method === "GET" && url.pathname === "/api/daily-records/summary") return json(res, 200, { dates: dailyRecordSummary(state, url.searchParams.get("month")) });
    if (req.method === "GET" && url.pathname === "/api/daily-records/search") return json(res, 200, searchDailyRecords(state, url.searchParams.get("q") || ""));
    if (req.method === "POST" && url.pathname === "/api/daily-records") return await createDailyRecord(req, res, state);
    const dailyRecord = url.pathname.match(/^\/api\/daily-records\/([^/]+)$/);
    if (req.method === "PUT" && dailyRecord) return await updateDailyRecord(req, res, state, dailyRecord[1]);
    if (req.method === "DELETE" && dailyRecord) return await deleteDailyRecord(req, res, state, dailyRecord[1]);

    if (req.method === "POST" && url.pathname === "/api/assistant/launch") return json(res, 200, { ok: true, url: "/assistant.html" });
    if (req.method === "GET" && url.pathname === "/api/agent/events") return events(req, res, state);
    if (req.method === "GET" && url.pathname === "/api/agent/bootstrap") return json(res, 200, bootstrap(state));
    if (req.method === "POST" && url.pathname === "/api/agent/command") return await agentCommand(req, res, state);
    if (req.method === "POST" && url.pathname === "/api/agent/new") return await newSession(req, res, state);
    if (req.method === "GET" && url.pathname === "/api/sessions/search") {
      const result = await state.searchReply?.(url.searchParams.get("q"));
      if (!res.destroyed) return json(res, 200, result || { complete: true, hits: [] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") return json(res, 200, { sessions: state.sessions });
    if (req.method === "POST" && url.pathname === "/api/sessions/activate") return await activateSession(req, res, state);
    if (req.method === "POST" && url.pathname === "/api/sessions/rename") return await renameSession(req, res, state);
    if (req.method === "DELETE" && url.pathname === "/api/sessions") return await deleteSession(req, res, state);

    if (req.method === "GET" && url.pathname === "/api/workspaces") return json(res, 200, workspaceList());
    if (req.method === "GET" && url.pathname === "/api/auth/providers") return json(res, 200, state.authProviders || { oauthProviders: [{ id: "openai-codex", name: "ChatGPT Plus/Pro", loggedIn: true, modelCount: 1 }], apiKeyProviders: [] });
    if (req.method === "GET" && url.pathname === "/api/models/catalog") return json(res, 200, modelCatalog(state));
    if (req.method === "GET" && url.pathname === "/api/models/config") return json(res, 200, { providers: {} });
    if (req.method === "GET" && url.pathname === "/api/skills") return json(res, 200, { skills: [], diagnostics: [], cliAvailable: false });
    if (req.method === "GET" && url.pathname === "/api/vskills") return json(res, 200, { vskills: [{ id: "weekly", name: "本周总结", prompt: "总结本周" }] });

    if (req.method === 'GET' && url.pathname === '/api/workspace/project-prompt') return json(res, 200, { ...await readProjectPrompt(state.projectRoot), workspaceId: workspace().id });
    if (req.method === 'PUT' && url.pathname === '/api/workspace/project-prompt') {
      const body = await readJson(req);
      if (body.workspaceId !== workspace().id || state.projectPromptBusy) return json(res, 409, { error: '当前项目已切换或任务正在执行' });
      return json(res, 200, { ...await saveProjectPrompt(state.projectRoot, body, path.join(state.projectRoot, 'prompt-backups')), workspaceId: workspace().id, applied: true });
    }
    if (req.method === "POST" && url.pathname === "/api/workspace/upload/check") return json(res, 200, { conflicts: [] });
    if (req.method === "POST" && url.pathname === "/api/workspace/upload") return await upload(req, res, url, state);
    if (req.method === "GET" && url.pathname === "/api/workspace/tree") return json(res, 200, tree(state));
    if (req.method === "GET" && url.pathname === "/api/workspace/search") return json(res, 200, { results: [...state.files].map(([name, content]) => ({ path: name, name, kind: "file", size: content.length, previewable: true })) });
    if (req.method === "GET" && url.pathname === "/api/workspace/preview") return await preview(res, url, state);
    if (req.method === 'GET' && url.pathname === '/api/work-documents') return json(res, 200, await state.workDocuments.read());
    if (req.method === 'PUT' && url.pathname === '/api/work-documents') { const body = await readJson(req); state.documentRequests.push(body); return json(res, 200, await state.workDocuments.save(body)); }
    if (req.method === 'POST' && url.pathname === '/api/work-documents/pick-file') { await readJson(req); const result = await (state.workDocuments.pick?.() || { cancelled: true }); return json(res, 200, result.cancelled ? result : { ...result, name: path.basename(result.path) }); }
    if (req.method === 'POST' && url.pathname === '/api/work-documents/remove') return json(res, 200, await state.workDocuments.remove(await readJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/work-documents/open') return json(res, 200, await state.workDocuments.open(await readJson(req)));
    if (req.method === 'GET' && url.pathname === '/api/apps/config') return json(res, 200, await state.workApps.read());
    if (req.method === 'PUT' && url.pathname === '/api/apps/config') return json(res, 200, await state.workApps.save(await readJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/apps/open') { const body = await readJson(req); return json(res, 200, await state.workApps.run(body.id, body.revision)); }
    if (req.method === "POST" && url.pathname === "/api/apps/open-all") return json(res, 200, await state.workApps.run());
    if (req.method === "GET") return await staticFile(url.pathname, res, state.appRoot);
    json(res, 404, { error: "接口不存在" });
  } catch (error) {
    json(res, Number(error.statusCode) || 500, { error: error.message });
  }
}

function workspace() { return { id: "test-workspace", name: "测试工作区", root: "TEMP", isDefault: true, available: true }; }
function workspaceList() { return { activeWorkspaceId: "test-workspace", items: [workspace()], warning: null }; }
function session(id, title) { return { id, path: `/temp/${id}.jsonl`, name: title, title, firstMessage: title, modified: new Date().toISOString(), messageCount: 0 }; }
function activeSession(state) { return state.sessions.find((item) => item.id === state.activeSessionId); }
function agentState(state) {
  const active = activeSession(state), catalog = modelCatalog(state);
  if (!state.sessionSettings.has(active?.id)) state.sessionSettings.set(active?.id, { model: { provider: catalog.defaultModel.provider, id: catalog.defaultModel.modelId }, thinkingLevel: catalog.defaultThinkingLevel });
  return { sessionId: active?.id || null, sessionFile: active?.path || null, isStreaming: false, ...state.sessionSettings.get(active?.id), contextUsage: { percent: 12 } };
}
function modelCatalog(state) { return state.modelCatalog || { models: [{ provider: "openai-codex", id: "gpt-test", name: "GPT Test", reasoning: true }], enabledModels: [], defaultModel: { provider: "openai-codex", modelId: "gpt-test" }, defaultThinkingLevel: "medium" }; }
function bootstrap(state) { return { state: agentState(state), messages: state.messages.get(state.activeSessionId) || [], models: modelCatalog(state).models, enabledModels: modelCatalog(state).enabledModels, visibleModelKeys: modelCatalog(state).visibleModelKeys, thinkingLevels: ["off", "medium", "high"], sessions: state.sessions, workspace: workspace(), workspaces: workspaceList(), turnFiles: { involved: [], modified: [] } }; }

function dashboard(state) {
  return { ...buildDashboard(state.tasks, { today: TODAY }), updatedAt: revision(state), stale: false, warning: null };
}
function dayDetails(state, date) {
  return { date, tasks: buildDayDetails(state.tasks, date), updatedAt: revision(state), stale: false, warning: null };
}
function revision(state) { return `revision-${state.revision}`; }
function requireRevision(state, body) {
  if (!body.revision) throw Object.assign(new Error('缺少目录版本'), { statusCode: 400 });
  if (body.revision !== revision(state)) throw Object.assign(new Error('版本已变化'), { statusCode: 409 });
}
function taskById(state, id) {
  const item = state.tasks.find(task => task.id === id);
  if (!item) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
  return item;
}

async function createTask(req, res, state) {
  const body = await readJson(req); requireRevision(state, body);
  let id;
  do { state.taskSequence = (state.taskSequence || 0) + 1; id = `task${String(state.taskSequence).padStart(8, '0')}`; } while (state.tasks.some(task => task.id === id));
  const kind = body.kind === undefined ? 'daily' : body.kind;
  validateTaskTimes(kind, body, true);
  state.tasks.push({ id, kind, text: body.text, editableText: body.text, ...(kind === 'longterm' ? { startDate: body.startDate, endDate: body.endDate, recurrence: body.recurrence } : { plannedDate: body.plannedDate, dueDate: body.dueDate }), completedDate: body.checked ? TODAY : null, checked: Boolean(body.checked), roles: [], headingPath: ['测试'] });
  state.operations.push("task:create"); state.revision += 1; json(res, 201, { ok: true, updatedAt: revision(state) });
}
async function updateTask(req, res, state, id) {
  const body = await readJson(req); requireRevision(state, body); const item = taskById(state, id);
  const kind = taskKind(item);
  if (body.kind !== undefined && body.kind !== kind) throw new Error('不能变更类型');
  validateTaskTimes(kind, body);
  item.kind = kind;
  if (body.startDate !== undefined) item.startDate = body.startDate;
  if (body.endDate !== undefined) item.endDate = body.endDate;
  if (body.text !== undefined) { item.text = body.text; item.editableText = body.text; state.operations.push("task:update"); }
  if (body.plannedDate !== undefined) item.plannedDate = body.plannedDate;
  if (body.dueDate !== undefined) item.dueDate = body.dueDate;
  if (body.recurrence !== undefined) item.recurrence = body.recurrence;
  if (body.checked !== undefined) { item.checked = body.checked; item.completedDate = body.checked ? TODAY : null; state.operations.push("task:complete"); }
  state.revision += 1; json(res, 200, { ok: true, updatedAt: revision(state) });
}
async function moveTask(req, res, state, id) {
  const body = await readJson(req); requireRevision(state, body); const item = taskById(state, id);
  const longterm = taskKind(item) === 'longterm';
  const first = longterm ? 'startDate' : 'plannedDate', last = longterm ? 'endDate' : 'dueDate';
  const next = { ...item };
  if (longterm && item.checked && item.completedDate === body.sourceDate) next.completedDate = body.targetDate;
  else {
    if (item[first] === body.sourceDate) next[first] = body.targetDate;
    if (item[last] === body.sourceDate) next[last] = body.targetDate;
    if (item.completedDate === body.sourceDate || (!longterm && item.checked)) next.completedDate = body.targetDate;
  }
  validateTaskTimes(taskKind(item), next);
  Object.assign(item, next);
  state.operations.push("task:move"); state.revision += 1; json(res, 200, { ok: true, updatedAt: revision(state) });
}
async function deleteTask(req, res, state, id) {
  const body = await readJson(req); requireRevision(state, body); taskById(state, id); state.tasks = state.tasks.filter((task) => task.id !== id);
  state.operations.push("task:delete"); state.revision += 1; json(res, 200, { ok: true, updatedAt: revision(state) });
}

function dailyRecordsForDate(state, date) {
  return state.dailyRecords.filter((record) => record.date === date).sort((left, right) => {
    if (left.time && right.time) return left.time.localeCompare(right.time);
    if (left.time) return -1;
    if (right.time) return 1;
    return right.createdAt.localeCompare(left.createdAt);
  });
}
function dailyRecordSummary(state, month) {
  const counts = new Map();
  for (const record of state.dailyRecords.filter((item) => item.date.startsWith(`${month}-`))) counts.set(record.date, (counts.get(record.date) || 0) + 1);
  return [...counts].map(([date, count]) => ({ date, count }));
}
function searchDailyRecords(state, query) {
  const key = query.toLowerCase();
  const matched = state.dailyRecords.filter((record) => [record.title, record.content, record.date].some((value) => value.toLowerCase().includes(key)));
  return { records: matched.slice(0, 50), total: matched.length, truncated: matched.length > 50 };
}
async function createDailyRecord(req, res, state) {
  const body = await readJson(req); const now = new Date(Date.UTC(2026, 8, 4, 10, 0, state.recordSequence++)).toISOString();
  const id = `00000000-0000-4000-8000-${String(state.recordSequence).padStart(12, "0")}`;
  const record = { id, date: body.date, title: body.title, type: body.type, time: body.time, content: body.content, createdAt: now, updatedAt: now };
  state.dailyRecords.push(record); state.operations.push("record:create"); json(res, 201, { ok: true, record });
}
async function updateDailyRecord(req, res, state, id) {
  const body = await readJson(req); const record = state.dailyRecords.find((item) => item.id === id);
  Object.assign(record, { title: body.title, type: body.type, time: body.time, content: body.content, updatedAt: new Date(Date.parse(record.updatedAt) + 1000).toISOString() });
  state.operations.push("record:update"); json(res, 200, { ok: true, record });
}
async function deleteDailyRecord(req, res, state, id) {
  await readJson(req); const record = state.dailyRecords.find((item) => item.id === id);
  state.dailyRecords = state.dailyRecords.filter((item) => item.id !== id); state.operations.push("record:delete"); json(res, 200, { ok: true, deleted: record });
}

function events(req, res, state) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  state.eventClients.add(res); emit(res, { type: "connected", running: true, state: "running", workspace: workspace() });
  const cleanup = () => state.eventClients.delete(res); req.on("close", cleanup); res.on("close", cleanup);
}
function broadcast(state, event) { for (const client of state.eventClients) emit(client, event); }
function emit(res, event) { res.write(`data: ${JSON.stringify(event)}\n\n`); }
async function agentCommand(req, res, state) {
  const command = await readJson(req);
  if (command.type === "get_state") return json(res, 200, { ok: true, data: agentState(state) });
  if (command.type === "get_messages") return json(res, 200, { ok: true, data: { messages: state.messages.get(state.activeSessionId) || [] } });
  if (command.type === "get_available_thinking_levels") return json(res, 200, { ok: true, data: { levels: ["off", "medium", "high"] } });
  if (command.type === 'get_available_models') return json(res, 200, { ok: true, data: { models: modelCatalog(state).models } });
  if (command.type === 'set_model') {
    if (!command.sessionId || command.sessionId !== state.activeSessionId) return json(res, 409, { error: '对话已切换' });
    const model = modelCatalog(state).models.find(m => m.provider === command.provider && m.id === command.modelId);
    if (!model) return json(res, 500, { error: `Model not found: ${command.provider}/${command.modelId}` });
    agentState(state); state.sessionSettings.get(state.activeSessionId).model = { provider: model.provider, id: model.id };
    state.operations.push('agent:model'); return json(res, 200, { ok: true, data: model });
  }
  if (command.type === 'set_thinking_level') {
    if (!['off', 'medium', 'high'].includes(command.level)) return json(res, 400, { error: 'UI fixture不支持此思考等级' });
    agentState(state); state.sessionSettings.get(state.activeSessionId).thinkingLevel = command.level;
    state.operations.push('agent:thinking'); return json(res, 200, { ok: true, data: null });
  }
  if (command.type === "abort" || command.type === "compact") return json(res, 200, { ok: true, data: agentState(state) });
  if (command.type === "prompt") {
    const messages = state.messages.get(state.activeSessionId) || [];
    messages.push({ role: "user", content: command.message }); state.messages.set(state.activeSessionId, messages);
    state.operations.push("agent:prompt"); json(res, 200, { ok: true, data: {} });
    const assistant = { role: "assistant", content: [{ type: "text", text: "冒烟回复" }] };
    setTimeout(() => {
      broadcast(state, { type: "agent_start" });
      broadcast(state, { type: "message_start", message: { role: "assistant", content: [] } });
      broadcast(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "冒烟回复" } });
      messages.push(assistant);
      broadcast(state, { type: "message_end", message: assistant });
      broadcast(state, { type: "agent_settled" });
    }, 20);
    return;
  }
  json(res, 400, { error: `UI fixture未实现命令：${command.type}` });
}
async function newSession(req, res, state) {
  await readJson(req); const id = `session-${state.sessions.length + 1}`; const item = session(id, `新对话 ${state.sessions.length + 1}`);
  state.sessions.unshift(item); state.messages.set(id, []); state.activeSessionId = id; state.operations.push("session:create");
  json(res, 201, { ok: true, state: agentState(state) });
}
async function activateSession(req, res, state) { const body = await readJson(req); state.activeSessionId = state.sessions.find((item) => item.path === body.path).id; state.operations.push("session:activate"); json(res, 200, { ok: true, state: agentState(state) }); }
async function renameSession(req, res, state) { const body = await readJson(req); const item = state.sessions.find((entry) => entry.path === body.path); item.name = item.title = body.name; state.operations.push("session:rename"); json(res, 200, { ok: true, renamed: true }); }
async function deleteSession(req, res, state) { const body = await readJson(req); const item = state.sessions.find((entry) => entry.path === body.path); const activeDeleted = item.id === state.activeSessionId; state.sessions = state.sessions.filter((entry) => entry !== item); state.messages.delete(item.id); if (activeDeleted) state.activeSessionId = state.sessions[0]?.id || null; state.operations.push("session:delete"); json(res, 200, { ok: true, deleted: true, activeDeleted }); }

async function upload(req, res, url, state) { const content = await readBody(req); const name = url.searchParams.get("name"); state.files.set(name, content); state.operations.push("workspace:upload"); json(res, 201, { ok: true, uploaded: { path: name, name, kind: "file", size: content.length, previewable: true } }); }
function tree(state) { return { path: "", entries: [...state.files].map(([name, content]) => ({ path: name, name, kind: "file", size: content.length, previewable: true })) }; }
async function preview(res, url, state) {
  const name = url.searchParams.get("path"), content = state.files.get(name);
  state.operations.push("workspace:preview");
  const override = await state.previewReply?.(name);
  if (!res.destroyed) json(res, 200, override || { path: name, kind: name.endsWith(".md") ? "markdown" : "text", content: content?.toString("utf8") || "" });
}

async function staticFile(requestPath, res, appRoot) {
  const shared = requestPath.startsWith('/shared/');
  const relative = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(shared ? 8 : 1));
  const base = path.join(appRoot, shared ? 'shared' : 'renderer');
  const file = path.resolve(base, relative);
  if (!file.startsWith(base + path.sep)) return json(res, 403, { error: "禁止访问" });
  try { const content = await readFile(file); res.writeHead(200, { "Content-Type": mime(file) }); res.end(content); }
  catch { json(res, 404, { error: "页面不存在" }); }
}
function mime(file) { return ({ ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" })[path.extname(file)] || "application/octet-stream"; }
async function readBody(req) { const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
async function readJson(req) { const content = await readBody(req); return content.length ? JSON.parse(content.toString("utf8")) : {}; }
function json(res, status, value) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
