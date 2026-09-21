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
  const current = sessionService.beginListRead();
  setIconBusy(el.refreshSessions, true);
  try {
    const listed = await sessionService.list();
    if (current()) renderSessions(listed);
  } catch (error) { if (!error.staleResponse) showError(error); }
  finally { setIconBusy(el.refreshSessions, false); }
}

async function newSession() {
  if (state.running && !await uiDialogs.confirm("当前任务仍在运行，是否仍要新建对话？", { title: "新建对话" })) return;
  try {
    await sessionService.create();
    await loadBootstrap();
  } catch (error) { if (!error.staleResponse) showError(error); if (error.refreshRequired?.()) await loadBootstrap(); }
}

async function activateSession(session) {
  if (state.running && !await uiDialogs.confirm("当前任务仍在运行，是否仍要切换会话？", { title: "切换会话" })) return;
  try {
    await sessionService.activate(session.path);
    await loadBootstrap();
  } catch (error) { if (!error.staleResponse) showError(error); if (error.refreshRequired?.()) await loadBootstrap(); }
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
    const title = document.createElement('b'); title.textContent = session.title; title.title = session.title;
    const meta = document.createElement('small'); meta.className = 'session-meta';
    const date = new Date(session.modified);
    for (const text of [date.toLocaleDateString(), date.toLocaleTimeString(), `${session.messageCount} 条`]) {
      const part = document.createElement('span'); part.textContent = text; meta.append(part);
    }
    button.append(title, meta);
    button.addEventListener("click", () => activateSession(session));
    const actions = createSessionMenu(session);
    row.append(button, actions);
    el.sessionList.append(row);
  }
}

function createSessionMenu(session) {
  const actions = document.createElement('div'); actions.className = 'session-actions';
  const more = document.createElement('button'); more.type = 'button';
  more.className = 'icon-action icon-action--compact session-more';
  more.setAttribute('aria-label', `更多操作：${session.title}`); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
  more.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
  const menu = document.createElement('div'); menu.className = 'session-menu'; menu.setAttribute('popover', 'auto'); menu.setAttribute('role', 'menu');
  const close = () => { menu.hidePopover(); if (more.isConnected) more.focus({ preventScroll: true }); };
  for (const [label, icon, operation] of [['重命名', 'pencil', renameSession], ['删除', 'trash-2', deleteSession]]) {
    const action = document.createElement('button'); action.type = 'button'; action.className = 'session-menu-item';
    if (label === '删除') action.classList.add('danger');
    action.setAttribute('role', 'menuitem'); action.setAttribute('aria-label', label === '删除' ? `删除对话：${session.title}` : label);
    action.innerHTML = `<svg aria-hidden="true"><use href="/icons.svg#${icon}"></use></svg><span>${label}</span>`;
    action.addEventListener('click', event => { event.stopPropagation(); close(); void operation(session); }); menu.append(action);
  }
  more.addEventListener('click', event => {
    event.stopPropagation();
    if (menu.matches(':popover-open')) { close(); return; }
    const rect = more.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(innerWidth - 180, rect.right - 168))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - 100, rect.bottom + 4))}px`;
    menu.showPopover(); menu.querySelector('button').focus({ preventScroll: true });
  });
  menu.addEventListener('toggle', () => more.setAttribute('aria-expanded', String(menu.matches(':popover-open'))));
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const items = [...menu.querySelectorAll('button')], index = items.indexOf(document.activeElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length].focus();
  });
  actions.append(more, menu); return actions;
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
    await sessionService.remove(session.path);
    await loadBootstrap();
    showNotice("对话已删除");
  } catch (error) { if (!error.staleResponse) showError(error); if (error.refreshRequired?.()) await loadBootstrap(); }
}
  function setCurrentSession(id) { state.currentSessionId = id || null; }
  return { clearSearch: searchView.reset, setCurrentSession, refreshSessions, newSession, activateSession, renderSessions, renameSession, deleteSession };
}
