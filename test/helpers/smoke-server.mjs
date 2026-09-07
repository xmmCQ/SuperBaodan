import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTempProject } from "./temp-project.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TODAY = "2026-09-04";

export async function createSmokeServer() {
  const temp = await createTempProject("super-baodan-browser-smoke-");
  const state = {
    revision: 1,
    tasks: [],
    dailyRecords: [],
    recordSequence: 0,
    files: new Map(),
    operations: [],
    sessions: [session("seed", "已有对话")],
    activeSessionId: "seed",
    messages: new Map([["seed", [
      { role: "user", content: "历史问题" },
      { role: "assistant", content: [{ type: "text", text: "已恢复的历史回复" }] },
    ]]]),
    eventClients: new Set(),
  };
  const server = http.createServer((req, res) => void handle(req, res, state));
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  return {
    port: server.address().port,
    state,
    root: temp.root,
    async close() {
      for (const client of state.eventClients) client.end();
      await new Promise((resolve) => server.close(resolve));
      await temp.cleanup();
    },
  };
}

async function handle(req, res, state) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, assistantInstalled: true, assistantRunning: true, assistantState: "running", workspace: workspace(), today: TODAY });
    if (req.method === "GET" && url.pathname === "/api/dashboard") return json(res, 200, dashboard(state));
    const day = url.pathname.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/);
    if (req.method === "GET" && day) return json(res, 200, dayDetails(state, day[1]));
    if (req.method === "POST" && url.pathname === "/api/tasks") return createTask(req, res, state);
    const move = url.pathname.match(/^\/api\/tasks\/([^/]+)\/move$/);
    if (req.method === "PATCH" && move) return moveTask(req, res, state, move[1]);
    const task = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (req.method === "PATCH" && task) return updateTask(req, res, state, task[1]);
    if (req.method === "DELETE" && task) return deleteTask(req, res, state, task[1]);

    if (req.method === "GET" && url.pathname === "/api/daily-records") return json(res, 200, { records: dailyRecordsForDate(state, url.searchParams.get("date")) });
    if (req.method === "GET" && url.pathname === "/api/daily-records/summary") return json(res, 200, { dates: dailyRecordSummary(state, url.searchParams.get("month")) });
    if (req.method === "GET" && url.pathname === "/api/daily-records/search") return json(res, 200, searchDailyRecords(state, url.searchParams.get("q") || ""));
    if (req.method === "POST" && url.pathname === "/api/daily-records") return createDailyRecord(req, res, state);
    const dailyRecord = url.pathname.match(/^\/api\/daily-records\/([^/]+)$/);
    if (req.method === "PUT" && dailyRecord) return updateDailyRecord(req, res, state, dailyRecord[1]);
    if (req.method === "DELETE" && dailyRecord) return deleteDailyRecord(req, res, state, dailyRecord[1]);

    if (req.method === "POST" && url.pathname === "/api/assistant/launch") return json(res, 200, { ok: true, url: "/assistant.html" });
    if (req.method === "GET" && url.pathname === "/api/agent/events") return events(req, res, state);
    if (req.method === "GET" && url.pathname === "/api/agent/bootstrap") return json(res, 200, bootstrap(state));
    if (req.method === "POST" && url.pathname === "/api/agent/command") return agentCommand(req, res, state);
    if (req.method === "POST" && url.pathname === "/api/agent/new") return newSession(req, res, state);
    if (req.method === "GET" && url.pathname === "/api/sessions") return json(res, 200, { sessions: state.sessions });
    if (req.method === "POST" && url.pathname === "/api/sessions/activate") return activateSession(req, res, state);
    if (req.method === "POST" && url.pathname === "/api/sessions/rename") return renameSession(req, res, state);
    if (req.method === "DELETE" && url.pathname === "/api/sessions") return deleteSession(req, res, state);

    if (req.method === "GET" && url.pathname === "/api/workspaces") return json(res, 200, workspaceList());
    if (req.method === "GET" && url.pathname === "/api/auth/providers") return json(res, 200, { oauthProviders: [{ id: "openai-codex", name: "ChatGPT Plus/Pro", loggedIn: true, modelCount: 1 }], apiKeyProviders: [] });
    if (req.method === "GET" && url.pathname === "/api/models/catalog") return json(res, 200, modelCatalog());
    if (req.method === "GET" && url.pathname === "/api/models/config") return json(res, 200, { providers: {} });
    if (req.method === "GET" && url.pathname === "/api/skills") return json(res, 200, { skills: [], diagnostics: [], cliAvailable: false });
    if (req.method === "GET" && url.pathname === "/api/vskills") return json(res, 200, { vskills: [{ id: "weekly", name: "本周总结", prompt: "总结本周" }] });

    if (req.method === "POST" && url.pathname === "/api/workspace/upload/check") return json(res, 200, { conflicts: [] });
    if (req.method === "POST" && url.pathname === "/api/workspace/upload") return upload(req, res, url, state);
    if (req.method === "GET" && url.pathname === "/api/workspace/tree") return json(res, 200, tree(state));
    if (req.method === "GET" && url.pathname === "/api/workspace/search") return json(res, 200, { results: [...state.files].map(([name, content]) => ({ path: name, name, kind: "file", size: content.length, previewable: true })) });
    if (req.method === "GET" && url.pathname === "/api/workspace/preview") return preview(res, url, state);
    if (req.method === "POST" && url.pathname === "/api/apps/open-all") return json(res, 200, { results: [] });
    if (req.method === "POST" && url.pathname === "/api/system/shutdown") return json(res, 200, { ok: true });
    if (req.method === "GET") return staticFile(url.pathname, res);
    json(res, 404, { error: "接口不存在" });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

function workspace() { return { id: "test-workspace", name: "测试工作区", root: "TEMP", isDefault: true, available: true }; }
function workspaceList() { return { activeWorkspaceId: "test-workspace", items: [workspace()], warning: null }; }
function session(id, title) { return { id, path: `/temp/${id}.jsonl`, name: title, title, firstMessage: title, modified: new Date().toISOString(), messageCount: 0 }; }
function activeSession(state) { return state.sessions.find((item) => item.id === state.activeSessionId); }
function agentState(state) { const active = activeSession(state); return { sessionId: active?.id || null, sessionFile: active?.path || null, isStreaming: false, model: { provider: "openai-codex", id: "gpt-test" }, thinkingLevel: "medium", contextUsage: { percent: 12 } }; }
function modelCatalog() { return { models: [{ provider: "openai-codex", id: "gpt-test", name: "GPT Test", reasoning: true }], enabledModels: [], defaultModel: { provider: "openai-codex", modelId: "gpt-test" }, defaultThinkingLevel: "medium" }; }
function bootstrap(state) { return { state: agentState(state), messages: state.messages.get(state.activeSessionId) || [], models: modelCatalog().models, enabledModels: [], thinkingLevels: ["off", "medium", "high"], sessions: state.sessions, workspace: workspace(), workspaces: workspaceList(), turnFiles: { involved: [], modified: [] } }; }

function dashboard(state) {
  const events = state.tasks.flatMap((task) => [task.plannedDate, task.dueDate, task.completedDate].filter(Boolean).map((date) => ({ date, roles: rolesFor(task, date), overdue: false })));
  const pendingByDate = {};
  for (const task of state.tasks.filter((item) => !item.checked)) for (const date of [task.plannedDate, task.dueDate].filter(Boolean)) pendingByDate[date] = (pendingByDate[date] || 0) + 1;
  return { today: TODAY, month: TODAY.slice(0, 7), events, pendingByDate, overdue: [], longTerm: state.tasks.filter((task) => task.recurrence), updatedAt: revision(state), stale: false, warning: null };
}
function dayDetails(state, date) {
  return { date, tasks: state.tasks.filter((task) => [task.plannedDate, task.dueDate, task.completedDate].includes(date)).map((task) => ({ ...task, roles: rolesFor(task, date) })), updatedAt: revision(state), stale: false, warning: null };
}
function rolesFor(task, date) { return [task.plannedDate === date && "planned", task.dueDate === date && "due", task.completedDate === date && "completed"].filter(Boolean); }
function revision(state) { return `revision-${state.revision}`; }

async function createTask(req, res, state) {
  const body = await readJson(req);
  const id = `task${String(state.tasks.length + 1).padStart(8, "0")}`.slice(0, 12);
  state.tasks.push({ id, text: body.text, editableText: body.text, plannedDate: body.plannedDate, dueDate: body.dueDate, completedDate: body.checked ? TODAY : null, recurrence: body.recurrence, checked: Boolean(body.checked), roles: [], headingPath: ["测试"] });
  state.operations.push("task:create"); state.revision += 1; json(res, 201, { ok: true, updatedAt: revision(state) });
}
async function updateTask(req, res, state, id) {
  const body = await readJson(req); const item = state.tasks.find((task) => task.id === id);
  if (body.text !== undefined) { item.text = body.text; item.editableText = body.text; state.operations.push("task:update"); }
  if (body.plannedDate !== undefined) item.plannedDate = body.plannedDate;
  if (body.dueDate !== undefined) item.dueDate = body.dueDate;
  if (body.checked !== undefined) { item.checked = body.checked; item.completedDate = body.checked ? TODAY : null; state.operations.push("task:complete"); }
  state.revision += 1; json(res, 200, { ok: true, updatedAt: revision(state) });
}
async function moveTask(req, res, state, id) {
  const body = await readJson(req); const item = state.tasks.find((task) => task.id === id);
  if (item.plannedDate === body.sourceDate) item.plannedDate = body.targetDate;
  if (item.dueDate === body.sourceDate) item.dueDate = body.targetDate;
  if (item.completedDate === body.sourceDate) item.completedDate = body.targetDate;
  state.operations.push("task:move"); state.revision += 1; json(res, 200, { ok: true, updatedAt: revision(state) });
}
async function deleteTask(req, res, state, id) {
  await readJson(req); state.tasks = state.tasks.filter((task) => task.id !== id);
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
  if (command.type === "set_model" || command.type === "set_thinking_level" || command.type === "abort" || command.type === "compact") return json(res, 200, { ok: true, data: agentState(state) });
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
  json(res, 200, { ok: true, data: {} });
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
function preview(res, url, state) { const name = url.searchParams.get("path"); const content = state.files.get(name); state.operations.push("workspace:preview"); json(res, 200, { path: name, kind: "text", content: content?.toString("utf8") || "" }); }

async function staticFile(requestPath, res) {
  const relative = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
  const file = path.resolve(path.join(ROOT, "public"), relative);
  if (!file.startsWith(path.join(ROOT, "public"))) return json(res, 403, { error: "禁止访问" });
  try { const content = await readFile(file); res.writeHead(200, { "Content-Type": mime(file) }); res.end(content); }
  catch { json(res, 404, { error: "页面不存在" }); }
}
function mime(file) { return ({ ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" })[path.extname(file)] || "application/octet-stream"; }
async function readBody(req) { const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
async function readJson(req) { const content = await readBody(req); return content.length ? JSON.parse(content.toString("utf8")) : {}; }
function json(res, status, value) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
