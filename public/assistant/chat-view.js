import { repairToolOutputEncoding } from "/assistant/text-normalization.js?v=1";

export function createChatView({
  state,
  elements: el,
  agentClient,
  sessionService,
  command,
  uiDialogs,
  renderMarkdown,
  showNotice,
  showError,
  getTurnFiles,
  setWorkspaceOpen,
  previewWorkspaceFile,
  updateStateFromAgent
}) {
  const ASSISTANT_WORKING_TEXT = "努力搬砖中！";
  const MESSAGE_BOTTOM_THRESHOLD = 80;
  let stickToMessageBottom = true;
  el.messages.addEventListener("scroll", () => {
    const distance = el.messages.scrollHeight - el.messages.clientHeight - el.messages.scrollTop;
    stickToMessageBottom = distance <= MESSAGE_BOTTOM_THRESHOLD;
  }, { passive: true });
  el.messages.addEventListener("wheel", (event) => {
    if (event.deltaY < 0) stickToMessageBottom = false;
  }, { passive: true });
  Object.defineProperty(state, "turnFiles", { get: getTurnFiles });
function createLiveAssistant(message) {
  if (state.live?.node?.isConnected) return;
  const node = createMessageShell("assistant");
  state.live = { node, bubble: node.querySelector(".bubble"), text: "", thinking: "", tools: new Map(), snapshot: message, renderFrame: null };
  el.messages.append(node);
  const rendered = message?.content?.length ? renderAssistantContent(state.live.bubble, message.content) : 0;
  if (!rendered) state.live.bubble.append(createAssistantStatus("正在思考…", "pending"));
  scrollBottom();
}

function applyDelta(delta) {
  if (!state.live) createLiveAssistant({ role: "assistant", content: [] });
  if (!state.live) return;
  if (delta.type === "text_delta") state.live.text += delta.delta || "";
  if (delta.type === "text_end" && typeof delta.content === "string") state.live.text = delta.content;
  if (delta.type === "thinking_delta") state.live.thinking += delta.delta || "";
  if (delta.type === "thinking_end" && typeof delta.content === "string") state.live.thinking = delta.content;
  if (delta.type === "toolcall_start") state.live.tools.set(delta.id || `tool-${state.live.tools.size}`, { name: delta.toolName || "tool", args: "" });
  if (delta.type === "toolcall_delta") {
    const key = delta.id || [...state.live.tools.keys()].at(-1);
    const tool = state.live.tools.get(key);
    if (tool) tool.args += delta.delta || "";
  }
  if (delta.type === "toolcall_end" && delta.toolCall) {
    const key = delta.toolCall.id || [...state.live.tools.keys()].at(-1);
    state.live.tools.set(key, { name: delta.toolCall.name || delta.toolCall.toolName || "tool", args: JSON.stringify(delta.toolCall.arguments || {}, null, 2) });
  }
  scheduleLiveAssistantRender();
}

function scheduleLiveAssistantRender() {
  const live = state.live;
  if (!live || live.renderFrame) return;
  live.renderFrame = requestAnimationFrame(() => {
    if (!state.live || state.live !== live) return;
    live.renderFrame = null;
    renderLiveAssistant();
    scrollBottom();
  });
}

function renderLiveAssistant() {
  const live = state.live;
  if (!live) return;
  live.bubble.replaceChildren();
  if (live.thinking) {
    const thinking = document.createElement("details");
    thinking.className = "thinking";
    const summary = document.createElement("summary");
    summary.textContent = "思考过程";
    const text = document.createElement("div");
    text.textContent = live.thinking;
    thinking.append(summary, text);
    live.bubble.append(thinking);
  }
  if (live.text) {
    const text = document.createElement("div");
    renderMarkdown(text, live.text, { onNotice: showNotice });
    live.bubble.append(text);
  }
  for (const tool of live.tools.values()) live.bubble.append(createToolCard(tool.name, tool.args));
  appendTurnFilesCard(live.bubble, state.turnFiles);
  if (!live.bubble.childElementCount) live.bubble.append(createAssistantStatus("正在思考…", "pending"));
}

function finalizeMessage(message) {
  if (!message) return;
  if (message.role === "assistant" && state.live?.node) {
    const replacement = createMessageNode(message, { turnFiles: state.turnFiles });
    state.live.node.replaceWith(replacement);
    state.live = null;
  } else if (message.role === "user") {
    const text = messageText(message);
    const last = el.messages.querySelector(".message:last-child .bubble");
    if (!last || last.textContent !== text) el.messages.append(createMessageNode(message));
  } else {
    el.messages.append(createMessageNode(message));
  }
  scrollBottom();
}

function renderMessages(messages, { forceScroll = true } = {}) {
  const shouldFollow = forceScroll || stickToMessageBottom;
  const previousScrollTop = el.messages.scrollTop;
  el.messages.replaceChildren();
  if (!messages.length) {
    const welcome = document.createElement("div");
    welcome.className = "welcome";
    welcome.innerHTML = '<img src="/baodan-assistant.png" alt="宝蛋"><h1>我已就绪</h1><p>来了！我是帮你搬砖的宝蛋，可以在设置里配置模型和skill哦~</p>';
    el.messages.append(welcome);
    return;
  }
  const lastAssistantIndex = messages.findLastIndex((message) => message.role === "assistant");
  messages.forEach((message, index) => {
    const turnFiles = index === lastAssistantIndex && state.turnFiles.involved.length ? state.turnFiles : null;
    el.messages.append(createMessageNode(message, { turnFiles }));
  });
  if (shouldFollow) scrollBottom("auto", forceScroll);
  else el.messages.scrollTop = previousScrollTop;
}

function createMessageNode(message, { turnFiles = null } = {}) {
  const role = message.role === "user" ? "user" : "assistant";
  const node = createMessageShell(role);
  const bubble = node.querySelector(".bubble");
  if (message.role === "assistant") {
    const rendered = renderAssistantContent(bubble, message.content || []);
    if (!rendered) bubble.append(createAssistantFallback(message));
    else if (message.stopReason === "error") bubble.append(createAssistantStatus(String(message.errorMessage || "").trim() || "模型请求失败。", "error"));
  } else if (message.role === "toolResult") {
    node.querySelector(".message-role").textContent = `工具结果 · ${message.toolName || message.toolCallId || "tool"}`;
    const pre = document.createElement("div");
    pre.className = "tool-result";
    pre.textContent = repairToolOutputEncoding(messageText(message));
    bubble.append(pre);
  } else {
    bubble.textContent = messageText(message);
  }
  if (message.role === "assistant" && turnFiles) appendTurnFilesCard(bubble, turnFiles);
  return node;
}

function appendTurnFilesCard(container, files) {
  if (!files?.involved?.length || container.querySelector(":scope > .turn-files-card")) return;
  const card = document.createElement("div");
  card.className = "turn-files-card";
  const modified = new Set(files.modified || []);
  const label = document.createElement("div");
  label.textContent = `本轮涉及文件 ${files.involved.length} 个 · 本轮修改文件 ${modified.size} 个`;
  card.append(label);
  for (const file of files.involved) {
    const button = document.createElement("button");
    button.textContent = `${modified.has(file) ? "✎ " : ""}${file}`;
    button.addEventListener("click", () => { setWorkspaceOpen(true); void previewWorkspaceFile(file); });
    card.append(button);
  }
  container.append(card);
}

function createMessageShell(role) {
  const node = document.createElement("article");
  node.className = `message ${role}`;
  const inner = document.createElement("div");
  inner.className = "message-inner";
  const label = document.createElement("div");
  label.className = "message-role";
  label.textContent = role === "user" ? "我" : "宝蛋";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  inner.append(label, bubble);
  node.append(inner);
  return node;
}

function renderAssistantContent(container, content) {
  let rendered = 0;
  let textBuffer = "";
  const flushText = () => {
    if (!textBuffer.trim()) { textBuffer = ""; return; }
    const block = document.createElement("div");
    renderMarkdown(block, textBuffer, { onNotice: showNotice });
    container.append(block);
    textBuffer = "";
    rendered += 1;
  };
  for (const part of Array.isArray(content) ? content : []) {
    if (part.type === "text") {
      textBuffer += String(part.text || "");
    } else if (part.type === "thinking" && String(part.thinking || "").trim()) {
      flushText();
      const details = document.createElement("details");
      details.className = "thinking";
      const summary = document.createElement("summary");
      summary.textContent = "思考过程";
      const block = document.createElement("div");
      block.textContent = part.thinking;
      details.append(summary, block);
      container.append(details);
      rendered += 1;
    } else if (part.type === "toolCall") {
      flushText();
      container.append(createToolCard(part.name || part.toolName || "tool", JSON.stringify(part.arguments || part.input || {}, null, 2)));
      rendered += 1;
    }
  }
  flushText();
  return rendered;
}

function createAssistantFallback(message) {
  if (message?.stopReason === "error") {
    return createAssistantStatus(String(message.errorMessage || "").trim() || "模型请求失败，未返回内容。", "error");
  }
  if (message?.stopReason === "aborted") {
    return createAssistantStatus("已停止生成。", "stopped");
  }
  return createAssistantStatus("模型未返回可显示内容，请重试或切换模型。", "empty");
}

function createAssistantStatus(text, type) {
  const status = document.createElement("div");
  status.className = `assistant-status ${type}`;
  status.textContent = text;
  return status;
}

function displayToolName(name) {
  return name === "bash" ? "PowerShell" : name;
}

function createToolCard(name, args = "") {
  name = displayToolName(name);
  const details = document.createElement("details");
  details.className = "tool-card";
  const summary = document.createElement("summary");
  const title = document.createElement("b");
  title.textContent = `工具 · ${name}`;
  summary.append(title);
  const pre = document.createElement("div");
  pre.className = "tool-result";
  pre.textContent = args;
  details.append(summary, pre);
  return details;
}

async function sendPrompt() {
  const message = el.promptInput.value.trim();
  if (!message && !state.images.length) return;
  el.promptInput.value = "";
  resizePrompt();
  const user = { role: "user", content: message || "[图片]" };
  el.messages.querySelector(".welcome")?.remove();
  el.messages.append(createMessageNode(user));
  scrollBottom("auto", true);
  const images = state.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
  clearImages();
  const wasRunning = state.running;
  try {
    state.running = true;
    state.streaming = true;
    state.lastAgentEventAt = Date.now();
    updateControls();
    startResponseFallback();
    await agentClient.send(message, {
      images,
      streamingBehavior: wasRunning ? "followUp" : undefined,
    });
  } catch (error) {
    stopResponseFallback();
    if (!wasRunning) {
      state.running = false;
      state.streaming = false;
      updateControls();
    }
    showError(error);
  }
}

async function compactSession() {
  try { showNotice("正在压缩上下文……"); await agentClient.compact(); }
  catch (error) { showError(error); }
}

async function showStats() {
  try {
    const [stats, stateInfo] = await Promise.all([command({ type: "get_session_stats" }), command({ type: "get_state" })]);
    el.statsContent.textContent = JSON.stringify({ ...stats, state: stateInfo }, null, 2);
    el.statsDialog.showModal();
  } catch (error) { showError(error); }
}

async function syncMessagesFromAgent() {
  try {
    const data = await sessionService.syncCurrent();
    renderMessages(data.messages, { forceScroll: false });
  } catch (error) { console.warn("同步消息失败", error); }
}

function startResponseFallback() {
  stopResponseFallback();
  state.responsePoll = setInterval(async () => {
    if (Date.now() - state.lastAgentEventAt < 1800) return;
    try {
      const [agentState, messages] = await Promise.all([
        command({ type: "get_state" }),
        command({ type: "get_messages" }),
      ]);
      if (Array.isArray(messages?.messages)) renderMessages(messages.messages, { forceScroll: false });
      updateStateFromAgent(agentState || {});
      if (!agentState?.isStreaming) stopResponseFallback();
    } catch {}
  }, 1500);
}

function stopResponseFallback() {
  if (state.responsePoll) clearInterval(state.responsePoll);
  state.responsePoll = null;
}

async function addImages() {
  const files = [...el.imageInput.files];
  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file);
    state.images.push({ name: file.name, mimeType: file.type, data: dataUrl.split(",", 2)[1] });
  }
  el.imageInput.value = "";
  renderAttachments();
}

function renderAttachments() {
  el.attachments.replaceChildren();
  el.attachments.classList.toggle("hidden", !state.images.length);
  state.images.forEach((image, index) => {
    const chip = document.createElement("button");
    chip.className = "attachment-chip";
    chip.textContent = `${image.name} ×`;
    chip.addEventListener("click", () => { state.images.splice(index, 1); renderAttachments(); });
    el.attachments.append(chip);
  });
}

function clearImages() { state.images = []; renderAttachments(); }

function readFileAsDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); }

async function handleExtensionUi(request) {
  try {
    if (request.method === "notify") return showNotice(request.message, request.notifyType === "error");
    if (request.method === "setTitle" && request.title) return document.title = request.title;
    if (request.method === "set_editor_text") { el.promptInput.value = request.text || ""; return resizePrompt(); }
    let response = { type: "extension_ui_response", id: request.id };
    if (request.method === "confirm") response.confirmed = await uiDialogs.confirm(request.message || "", { title: request.title || "确认" });
    else if (request.method === "select") {
      const value = await uiDialogs.select(request.title || "请选择", request.options || [], { message: request.message || "", initialValue: request.options?.[0] || "" });
      if (value == null) response.cancelled = true; else response.value = value;
    } else if (request.method === "input" || request.method === "editor") {
      const options = { message: request.message || "", placeholder: request.placeholder || "" };
      const value = request.method === "editor"
        ? await uiDialogs.editor(request.title || "请输入", request.prefill || "", options)
        : await uiDialogs.prompt(request.title || "请输入", request.prefill || "", options);
      if (value == null) response.cancelled = true; else response.value = value;
    } else return;
    await command(response);
  } catch (error) { showError(error); }
}

function clearWorkspaceDraft() {
  el.promptInput.value = "";
  resizePrompt();
  clearImages();
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("");
}

function updateControls() {
  el.stopButton.classList.toggle("hidden", !state.running);
  el.sendButton.disabled = false;
  updateToolStatus();
}

function updateToolStatus() {
  const text = state.running ? ASSISTANT_WORKING_TEXT : "";
  el.toolStatus.textContent = text;
  el.toolStatus.classList.toggle("hidden", !text);
}

function setRuntime(text, status = "") {
  el.runtimeText.textContent = text;
  el.runtimeDot.className = status;
}

function resizePrompt() { el.promptInput.style.height = "auto"; el.promptInput.style.height = `${Math.min(el.promptInput.scrollHeight, 180)}px`; }

function scrollBottom(behavior = "auto", force = false) {
  if (force) stickToMessageBottom = true;
  if (!force && !stickToMessageBottom) return;
  requestAnimationFrame(() => {
    if (!force && !stickToMessageBottom) return;
    el.messages.scrollTo({ top: el.messages.scrollHeight, behavior });
  });
}
  function isRunning() { return state.running; }
  function isStreaming() { return state.streaming; }
  function setRuntimeState({ running = state.running, streaming = state.streaming } = {}) { state.running = Boolean(running); state.streaming = Boolean(streaming); updateControls(); }
  function setLastAgentEventAt(value) { state.lastAgentEventAt = value; }
  function settle(agentState) { state.running = Boolean(agentState?.running); state.streaming = Boolean(agentState?.streaming); state.live = null; stopResponseFallback(); updateControls(); }
  function toolStarted(id, name) { state.activeTools.set(id, displayToolName(name || "tool")); updateToolStatus(); }
  function toolEnded(id) { state.activeTools.delete(id); updateToolStatus(); }
  function imageCount() { return state.images.length; }
  return { isRunning, isStreaming, setRuntimeState, setLastAgentEventAt, settle, toolStarted, toolEnded, imageCount, createLiveAssistant, applyDelta, scheduleLiveAssistantRender, renderLiveAssistant, finalizeMessage, renderMessages, createMessageNode, appendTurnFilesCard, createMessageShell, renderAssistantContent, createAssistantFallback, createAssistantStatus, displayToolName, createToolCard, sendPrompt, compactSession, showStats, syncMessagesFromAgent, startResponseFallback, stopResponseFallback, addImages, renderAttachments, clearImages, readFileAsDataUrl, handleExtensionUi, clearWorkspaceDraft, messageText, repairToolOutputEncoding, updateControls, updateToolStatus, setRuntime, resizePrompt, scrollBottom };
}
