import { createMessageWindow, HISTORY_TOP_THRESHOLD, prependPreviousMessages, afterHistoryRestore } from "../core/chat-lazy-load.js";
import { messageBodyText as chatMessageText } from "../core/reply-actions.js";

export function createHomeChat({
  state,
  elements: el,
  api,
  agentClient,
  sessionService, replyActions, directory,
  workspaceSwitcher,
  renderMarkdown,
  toast,
  escapeHtml,
  formatDateTime,
  loadingState,
  closeVSkillDrawer,
  uiDialogs
}) {
  const HOME_ASSISTANT_WORKING_TEXT = "努力搬砖中！";
  const CHAT_BOTTOM_THRESHOLD = 80;
  let stickToChatBottom = true;
  const historyWindow = createMessageWindow();
  let restoringHistory = false, previousTop = 0;
  el.chatMessages.addEventListener("scroll", () => {
    const top = el.chatMessages.scrollTop, scrollingUp = top < previousTop;
    previousTop = top;
    if (el.chatMessages.dataset?.readingAdjustment || el.chatMessages.dataset?.directoryJump) return;
    const distance = el.chatMessages.scrollHeight - el.chatMessages.clientHeight - top;
    stickToChatBottom = distance <= CHAT_BOTTOM_THRESHOLD;
    if (scrollingUp && !restoringHistory) loadEarlierMessages();
  }, { passive: true });
  el.chatMessages.addEventListener("wheel", (event) => {
    if (event.deltaY < 0) { stickToChatBottom = false; loadEarlierMessages(); }
  }, { passive: true });

const finishHistoryRestore = () => afterHistoryRestore(el.chatMessages, (top) => { previousTop = top; restoringHistory = false; });
function loadEarlierMessages(force = false) {
  if (restoringHistory) return "pending";
  if (!historyWindow.hasPrevious()) return "end";
  if (!force && el.chatMessages.scrollTop > HISTORY_TOP_THRESHOLD) return "idle";
  restoringHistory = true; stickToChatBottom = false;
  prependPreviousMessages(historyWindow, el.chatMessages, createHistoryMessage);
  finishHistoryRestore(); return "loaded";
}
function createHistoryMessage(message, index) {
  const node = createMessage(message.role, chatMessageText(message) || "[图片]");
  node.dataset.messageIndex = index;
  if (message.stopReason === "error") node.classList.add("error");
  replyActions?.attach(node, message);
  return node;
}
async function warmupAgent() {
  setAgentStatus("正在准备对话……", "loading");
  try {
    await agentClient.launch();
    setAgentStatus(state.chatBusy ? "正在处理……" : "", "ready");
  } catch (error) {
    setAgentStatus("对话准备失败，请重试", "error", error.message);
    toast(error.message || "对话准备失败，请重试", true);
  }
}

async function loadAgentStatus() {
  try {
    const data = await api("/api/health", { cache: "no-store" });
    if (!data.assistantInstalled) setAgentStatus("缺少助手组件，请安装 Windows Pi", "error");
    else if (data.assistantState === "error") setAgentStatus("对话暂不可用，请重试", "error");
    else if (data.assistantState === "busy") setAgentStatus("正在处理……", "ready");
    else if (data.assistantState === "starting") setAgentStatus("正在准备对话……", "loading");
    else setAgentStatus("", "ready");
  } catch {
    setAgentStatus("服务连接失败", "error");
  }
}

async function loadHomeChatBootstrap() {
  try {
    const data = await agentClient.bootstrap();
    state.workspace = data.workspace || state.workspace;
    if (data.workspaces) workspaceSwitcher.sync(data.workspaces);
    if (data.workspaces?.warning && !sessionStorage.getItem("super-baodan-workspace-warning")) {
      sessionStorage.setItem("super-baodan-workspace-warning", "shown");
      toast(data.workspaces.warning, true);
    }
    state.activeSessionId = data.state?.sessionId || null;
    state.activeSessionPath = data.state?.sessionFile || null;
    state.chatBusy = Boolean(data.state?.isStreaming);
    renderChatMessages(data.messages || [], { hideTrailingAssistant: state.chatBusy });
    if (state.chatBusy) showHomeAssistantWorking();
    setChatControls(state.chatBusy);
  } catch (error) {
    console.warn(error);
    renderChatWelcome();
  }
}

async function syncHomeChatMessages() {
  try {
    const { state: current, messages } = await sessionService.syncCurrent();
    state.activeSessionId = current?.sessionId || state.activeSessionId;
    state.activeSessionPath = current?.sessionFile || state.activeSessionPath;
    state.chatBusy = Boolean(current?.isStreaming);
    renderChatMessages(messages, { hideTrailingAssistant: state.chatBusy, forceScroll: false });
    if (state.chatBusy) showHomeAssistantWorking();
    setChatControls(state.chatBusy);
  } catch (error) {
    console.warn(error);
  }
}

function handleHomeChatEvent(event) {
  const agentState = agentClient.applyEvent(event);
  if (event.type === "connected" && event.workspace) {
    state.workspace = event.workspace;
    workspaceSwitcher.sync({ workspace: event.workspace });
  } else if (event.type === "agent_start") {
    state.chatBusy = agentState.running;
    state.liveText = "";
    showHomeAssistantWorking();
    setChatControls(true);
  } else if (event.type === "message_start" && event.message?.role === "assistant") {
    showHomeAssistantWorking();
  } else if (event.type === "message_update") {
    const delta = event.assistantMessageEvent || {};
    if (delta.type === "text_delta") state.liveText += delta.delta || "";
    if (delta.type === "text_end" && typeof delta.content === "string") state.liveText = delta.content;
  } else if (event.type === "tool_execution_start") {
    showHomeAssistantWorking();
  } else if (event.type === "agent_settled") {
    state.chatBusy = agentState.running;
    state.liveText = "";
    setChatControls(false);
    void syncHomeChatMessages();
    if (!el.chatHistoryDrawer.classList.contains("hidden")) void loadHistoryList();
  } else if (event.type === "runtime_exit") {
    state.chatBusy = agentState.running;
    if (state.liveAssistant?.isConnected) {
      state.liveAssistant.textContent = event.error || "对话连接中断，请重试";
      state.liveAssistant.classList.remove("working");
      state.liveAssistant.classList.add("error");
      state.liveAssistant.removeAttribute("role");
      state.liveAssistant.removeAttribute("aria-label");
    } else appendMessage("assistant", event.error || "对话连接中断，请重试").classList.add("error");
    state.liveAssistant = null;
    setChatControls(false);
    setAgentStatus("对话暂不可用，请重试", "error", event.error);
  } else if (event.type === "runtime_idle") {
    setAgentStatus("", "ready");
  } else if (event.type === "workspace_changed") {
    if (event.renamed) {
      state.workspace = event.workspace;
      workspaceSwitcher.sync({ workspace: event.workspace });
      return;
    }
    const hadDraft = Boolean(el.chatInput.value.trim());
    el.chatInput.value = "";
    autoResizeInput();
    state.workspace = event.workspace;
    workspaceSwitcher.sync({ workspace: event.workspace });
    scheduleHomeWorkspaceReload(`已切换到工作区：${event.workspace.name}${hadDraft ? "，未发送内容已清空" : ""}`);
  }
}

function renderChatMessages(messages, { hideTrailingAssistant = false, forceScroll = true } = {}) {
  replyActions?.syncContext();
  const shouldFollow = forceScroll || stickToChatBottom;
  const previousScrollTop = el.chatMessages.scrollTop;
  let visible = messages.filter((message) => ["user", "assistant"].includes(message.role));
  if (hideTrailingAssistant && visible.at(-1)?.role === "assistant") visible = visible.slice(0, -1);
  visible = visible.filter((message) => chatMessageText(message).trim() || (message.role === "user" && message.content?.some?.((part) => part.type === "image")));
  directory?.update(visible);
  if (!visible.length) {
    renderChatWelcome();
    return;
  }
  restoringHistory = true;
  const page = historyWindow.update(visible, { reset: forceScroll });
  el.chatMessages.replaceChildren();
  const fragment = document.createDocumentFragment();
  page.messages.forEach((message, index) => fragment.append(createHistoryMessage(message, page.start + index)));
  el.chatMessages.append(fragment);
  state.liveAssistant = null;
  if (shouldFollow) scrollChat(forceScroll);
  else el.chatMessages.scrollTop = previousScrollTop;
  finishHistoryRestore();
}

function openChatHistory() {
  if (state.chatBusy) return;
  closeVSkillDrawer();
  state.historyTab = "sessions";
  updateHistoryTabs();
  el.chatHistoryDrawer.classList.remove("hidden");
  loadHistoryList();
}

function closeChatHistory() {
  state.historyRequest += 1;
  el.chatHistoryDrawer.classList.add("hidden");
}

function switchHistoryTab(tab) {
  if (state.historyTab === tab) return;
  state.historyTab = tab;
  updateHistoryTabs();
  loadHistoryList();
}

function updateHistoryTabs() {
  state.historyTab = "sessions";
  el.historySessionsTab.classList.add("active");
}

async function loadHistoryList() {
  const requestId = ++state.historyRequest;
  const tab = state.historyTab;
  state.historyBusy = true;
  el.chatHistoryList.innerHTML = loadingState();
  try {
    const sessions = await sessionService.list();
    if (requestId !== state.historyRequest || tab !== state.historyTab) return;
    state.historyItems = sessions.map((session) => ({
      ...session,
      active: session.id === state.activeSessionId,
      updatedAt: session.modified,
      deletable: true,
    }));
    renderHistoryList();
  } catch (error) {
    if (requestId === state.historyRequest) {
      el.chatHistoryList.innerHTML = `<div class="history-empty">${escapeHtml(error.message)}</div>`;
    }
  } finally {
    if (requestId === state.historyRequest) state.historyBusy = false;
  }
}

function renderHistoryList() {
  if (!state.historyItems.length) {
    el.chatHistoryList.innerHTML = '<div class="history-empty">暂无历史对话</div>';
    return;
  }

  el.chatHistoryList.innerHTML = state.historyItems.map((item) => {
    const time = formatDateTime(new Date(item.modified || item.updatedAt));
    const meta = `<span>${time}</span><span>${item.messageCount} 条消息</span>${item.active ? '<span class="active-label">当前对话</span>' : ""}`;
    const main = `<button class="history-item-main" data-history-action="activate" type="button"><strong class="history-item-title">${escapeHtml(item.title)}</strong><span class="history-item-meta">${meta}</span></button>`;
    const actions = '<button class="history-action" data-history-action="rename" type="button">改名</button><button class="history-action delete" data-history-action="delete" type="button">删除</button>'; 
    return `<article class="history-item ${item.active ? "active" : ""}" data-session-id="${item.id}">${main}<div class="history-item-actions">${actions}</div></article>`;
  }).join("");
}

function handleHistoryClick(event) {
  const action = event.target.closest("[data-history-action]")?.dataset.historyAction;
  const card = event.target.closest("[data-session-id]");
  if (!action || !card || state.historyBusy) return;
  const item = state.historyItems.find((entry) => entry.id === card.dataset.sessionId);
  if (!item) return;
  if (action === "activate") activateHistorySession(item);
  if (action === "rename") startHistoryRename(card, item);
  if (action === "delete") deleteHistorySession(item);
  if (action === "cancel-rename") renderHistoryList();
}

function startHistoryRename(card, item) {
  card.innerHTML = `
    <form class="history-rename">
      <input name="name" maxlength="60" value="${escapeHtml(item.name || item.title)}" aria-label="对话名称" required>
      <button data-action="save-rename" type="submit">保存</button>
      <button data-history-action="cancel-rename" type="button">取消</button>
    </form>`;
  const input = card.querySelector("input");
  input.focus();
  input.select();
}

async function handleHistoryRenameSubmit(event) {
  event.preventDefault();
  if (state.historyBusy) return;
  const card = event.target.closest("[data-session-id]");
  const name = new FormData(event.target).get("name")?.toString().trim();
  if (!card || !name) return;

  state.historyBusy = true;
  try {
    const item = state.historyItems.find((entry) => entry.id === card.dataset.sessionId);
    if (!item) throw new Error("会话不存在");
    await sessionService.rename(item.path, name);
    await loadHistoryList();
    toast("对话已重命名");
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.historyBusy = false;
  }
}

async function activateHistorySession(item) {
  if (item.active) {
    closeChatHistory();
    return;
  }
  state.historyBusy = true;
  try {
    await sessionService.activate(item.path);
    await loadHomeChatBootstrap();
    closeChatHistory();
    toast("已切换历史对话");
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.historyBusy = false;
  }
}

async function deleteHistorySession(item) {
  if (!await uiDialogs.confirm(`确定删除对话“${item.title}”吗？`, { title: "删除对话", danger: true, confirmText: "删除" })) return;
  state.historyBusy = true;
  try {
    await sessionService.remove(item.path);
    if (item.active) {
      state.activeSessionId = null;
      state.activeSessionPath = null;
      renderChatWelcome(true);
    }
    await loadHistoryList();
    toast("对话已删除");
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.historyBusy = false;
  }
}

async function sendChat(message) {
  if (state.chatBusy) return;
  const quoted = replyActions?.take(message); message = quoted?.message ?? message;
  state.chatBusy = true;
  state.liveAssistant = null;
  state.liveText = "";
  appendMessage("user", message, { forceScroll: true });
  el.chatInput.value = "";
  autoResizeInput();
  showHomeAssistantWorking();
  setChatControls(true);
  try {
    await agentClient.send(message, { launchFirst: true });
  } catch (error) {
    state.liveAssistant?.remove();
    state.liveAssistant = null;
    appendMessage("assistant", error.message).classList.add("error");
    if (!error.acceptanceUnknown) replyActions?.restore(quoted);
    state.chatBusy = Boolean(error.acceptanceUnknown);
    setChatControls(state.chatBusy);
    if (error.acceptanceUnknown) void syncHomeChatMessages(); else void loadAgentStatus();
  }
}

async function newHomeChat() {
  if (state.chatBusy) return;
  setChatStatus("正在新建对话……");
  try {
    await sessionService.create();
    state.activeSessionId = null;
    state.activeSessionPath = null;
    renderChatWelcome(true);
    closeChatHistory();
    await loadHomeChatBootstrap();
    toast("新对话已开始");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setChatStatus("");
  }
}

async function stopHomeChat() {
  try {
    await agentClient.stop();
  } catch (error) {
    toast(error.message, true);
  }
}

async function openAssistantWorkspace() {
  try {
    const data = await agentClient.launch();
    window.location.href = data.url;
  } catch (error) {
    toast(error.message, true);
  }
}

function createMessage(role, text) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  if (role === "assistant") renderMarkdown(node, text, { onNotice: toast });
  else node.textContent = text;
  return node;
}

function appendMessage(role, text, { forceScroll = false } = {}) {
  const node = createMessage(role, text);
  el.chatMessages.appendChild(node);
  scrollChat(forceScroll);
  return node;
}

function showHomeAssistantWorking() {
  setChatStatus("");
  if (!state.liveAssistant?.isConnected) state.liveAssistant = appendMessage("assistant", "");
  const bubble = state.liveAssistant;
  bubble.classList.add("working");
  bubble.setAttribute("role", "status");
  bubble.setAttribute("aria-label", HOME_ASSISTANT_WORKING_TEXT);
  if (!bubble.querySelector(".home-working-bricks")) {
    const bricks = document.createElement("span");
    bricks.className = "home-working-bricks";
    bricks.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index += 1) {
      const brick = document.createElement("i");
      brick.className = "home-working-brick";
      bricks.append(brick);
    }
    const text = document.createElement("span");
    text.className = "home-working-text";
    text.textContent = HOME_ASSISTANT_WORKING_TEXT;
    bubble.replaceChildren(bricks, text);
  }
  scrollChat();
  return bubble;
}

function setChatControls(busy) {
  setAgentStatus(busy ? "正在处理……" : "", "ready");
  el.sendButton.disabled = false;
  el.sendButton.classList.toggle("icon-primary", !busy);
  el.sendButton.classList.toggle("icon-danger", busy);
  const actionLabel = busy ? "停止回复" : "发送";
  const actionIcon = busy ? "square-stop" : "arrow-up";
  el.sendButton.setAttribute("aria-label", actionLabel);
  el.sendButton.dataset.tooltip = actionLabel;
  el.sendButton.querySelector("use")?.setAttribute("href", `/icons.svg#${actionIcon}`);
  el.openVSkillButton.disabled = busy;
  for (const button of el.vskillQuickbar.querySelectorAll("button")) button.disabled = busy;
  el.openChatHistoryButton.disabled = busy;
  el.historyNewChatButton.disabled = busy;
  el.newChatButton.disabled = busy;
  setChatStatus("");
}

function renderChatWelcome(isNew = false) {
  directory?.update([]);
  replyActions?.syncContext();
  historyWindow.clear();
  el.chatMessages.innerHTML = `
    <div class="welcome-card">
      <strong>${isNew ? "新对话已开始" : "早上好"}</strong>
      <p>来了！我是帮你搬砖的宝蛋，请指示！</p>
    </div>`;
}

function setChatStatus(text) {
  el.chatStatus.textContent = text;
  el.chatStatus.classList.toggle("hidden", !text);
}

function setAgentStatus(text, status, title = "") {
  el.agentDot.className = `assistant-service-dot tooltip-control tooltip-down ${status === "ready" ? "ready" : status === "error" ? "error" : ""}`.trim();
  el.agentDot.classList.toggle("hidden", !text);
  el.agentDot.setAttribute("aria-label", text);
  el.agentDot.dataset.tooltip = title || text;
}

function scheduleHomeWorkspaceReload(message = "") {
  clearTimeout(state.workspaceReloadTimer);
  state.workspaceReloadTimer = setTimeout(async () => {
    await loadHomeChatBootstrap();
    if (!el.chatHistoryDrawer.classList.contains("hidden")) await loadHistoryList();
    if (message) toast(message);
  }, 80);
}

function autoResizeInput() {
  el.chatInput.style.height = "auto";
  el.chatInput.style.height = `${Math.min(el.chatInput.scrollHeight, 120)}px`;
}

function scrollChat(force = false) {
  if (force) stickToChatBottom = true;
  if (!force && !stickToChatBottom) return;
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}
  function setWorkspace(workspace) { state.workspace = workspace; }
  function workspace() { return state.workspace; }
  function isBusy() { return state.chatBusy; }
  return { loadDirectoryPage: () => loadEarlierMessages(true), pauseFollow: () => { stickToChatBottom = false; }, setWorkspace, workspace, isBusy, warmupAgent, loadAgentStatus, loadHomeChatBootstrap, syncHomeChatMessages, handleHomeChatEvent, renderChatMessages, chatMessageText, openChatHistory, closeChatHistory, switchHistoryTab, updateHistoryTabs, loadHistoryList, renderHistoryList, handleHistoryClick, startHistoryRename, handleHistoryRenameSubmit, activateHistorySession, deleteHistorySession, sendChat, newHomeChat, stopHomeChat, openAssistantWorkspace, appendMessage, showHomeAssistantWorking, setChatControls, renderChatWelcome, setChatStatus, setAgentStatus, scheduleHomeWorkspaceReload, autoResizeInput, scrollChat };
}
