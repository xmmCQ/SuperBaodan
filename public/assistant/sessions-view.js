import { createSessionSearch } from "../core/session-search.js";

export function createSessionsView({
  state,
  elements: el,
  sessionService,
  uiDialogs,
  setIconBusy,
  getRunning,
  getWorkspaceId,
  loadBootstrap,
  showNotice,
  showError
}) {
  Object.defineProperty(state, "running", { get: getRunning });
  const searchView = createSessionSearch({
    input: el.sessionSearch, results: el.sessionSearchResults, defaultList: el.sessionList,
    search: sessionService.search, getWorkspaceId,
    onOpen: (hit) => activateSession({ path: hit.sessionPath }),
  });
async function refreshSessions() {
  setIconBusy(el.refreshSessions, true);
  try {
    renderSessions(await sessionService.list());
  } catch (error) { showError(error); }
  finally { setIconBusy(el.refreshSessions, false); }
}

async function newSession() {
  if (state.running && !await uiDialogs.confirm("当前任务仍在运行，是否仍要新建对话？", { title: "新建对话" })) return;
  try {
    await sessionService.create();
    await loadBootstrap();
  } catch (error) { showError(error); }
}

async function activateSession(session) {
  if (state.running && !await uiDialogs.confirm("当前任务仍在运行，是否仍要切换会话？", { title: "切换会话" })) return;
  try {
    await sessionService.activate(session.path);
    await loadBootstrap();
  } catch (error) { showError(error); }
}

function renderSessions(sessions) {
  state.sessions = sessions;
  const visible = sessions;
  searchView.refresh();
  el.sessionList.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("div"); empty.className = "muted"; empty.textContent = "暂无历史对话"; el.sessionList.append(empty); return;
  }
  for (const session of visible) {
    const row = document.createElement("div");
    row.className = `session-row ${session.id === state.currentSessionId ? "active" : ""}`;
    const button = document.createElement("button");
    button.className = "session-item";
    const title = document.createElement("b"); title.textContent = session.title;
    const meta = document.createElement("small"); meta.textContent = `${new Date(session.modified).toLocaleString()} · ${session.messageCount} 条`;
    button.append(title, meta);
    button.addEventListener("click", () => activateSession(session));
    const actions = document.createElement("div"); actions.className = "session-actions";
    const renameButton = document.createElement("button"); renameButton.className = "icon-action icon-accent tooltip-left"; renameButton.dataset.tooltip = "重命名"; renameButton.setAttribute("aria-label", "重命名"); renameButton.innerHTML = '<svg aria-hidden="true"><use href="/icons.svg#pencil"></use></svg>';
    renameButton.addEventListener("click", (event) => { event.stopPropagation(); void renameSession(session); });
    const remove = document.createElement("button");
    const removeLabel = `删除对话：${session.title}`;
    remove.className = "icon-action icon-danger tooltip-left";
    remove.dataset.tooltip = removeLabel;
    remove.setAttribute("aria-label", removeLabel);
    remove.innerHTML = '<svg aria-hidden="true"><use href="/icons.svg#trash-2"></use></svg>';
    remove.addEventListener("click", (event) => { event.stopPropagation(); void deleteSession(session); });
    actions.append(renameButton, remove);
    row.append(button, actions);
    el.sessionList.append(row);
  }
}

async function renameSession(session) {
  const name = await uiDialogs.prompt("输入新的会话名称", session.name || session.title);
  if (name == null || !name.trim() || name.trim() === session.name) return;
  try {
    await sessionService.rename(session.path, name.trim());
    await refreshSessions();
    showNotice("会话已重命名");
  } catch (error) { showError(error); }
}

async function deleteSession(session) {
  if (!await uiDialogs.confirm(`删除对话“${session.title}”？此操作不可恢复。`, { title: "删除对话", danger: true, confirmText: "删除" })) return;
  try {
    const result = await sessionService.remove(session.path);
    if (result.activeDeleted) await loadBootstrap();
    else await refreshSessions();
    showNotice("对话已删除");
  } catch (error) { showError(error); }
}
  function setCurrentSession(id) { state.currentSessionId = id || null; }
  return { clearSearch: searchView.reset, setCurrentSession, refreshSessions, newSession, activateSession, renderSessions, renameSession, deleteSession };
}
