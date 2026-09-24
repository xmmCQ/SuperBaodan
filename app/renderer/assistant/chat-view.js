import { repairToolOutputEncoding } from "/assistant/text-normalization.js?v=1";
import { createAgentUi } from '../core/agent-ui.js';
import { createSnapshotRecovery } from '../core/snapshot-recovery.js';
import { createMessageWindow, HISTORY_TOP_THRESHOLD, prependPreviousMessages, afterHistoryRestore } from "../core/chat-lazy-load.js";
import { cancelReadingAdjustment, preserveReadingPositions } from '../core/reading-position.js';
import { createStreamingMarkdown, updateStreamingText } from '../core/streaming-markdown.js';
import { createResponseFallback } from "../core/response-fallback.js";
import { createImageAttachments } from './image-attachments.js';
import { validatePromptPayload } from '../../shared/prompt-images.js';

export function createChatView({
  state,
  elements: el,
  agentClient,
  sessionService, replyActions, directory, execution,
  command,
  uiDialogs,
  renderMarkdown,
  showNotice,
  showError,
  getTurnFiles,
  setTurnFiles = () => {},
  getScope = () => `${agentClient.state?.().workspace?.id || ''}:${agentClient.state?.().sessionId || ''}`,
  setWorkspaceOpen,
  previewWorkspaceFile,
  updateStateFromAgent
}) {
  const agentUi=createAgentUi({command,uiDialogs,input:el.promptInput,resize:resizePrompt,notice:showNotice,error:showError});
  const ASSISTANT_WORKING_TEXT = "努力搬砖中！";
  const MESSAGE_BOTTOM_THRESHOLD = 80;
  let stickToMessageBottom = true, scrollEpoch = 0, sending = null;
  const attachments = createImageAttachments({ state, input: el.imageInput, container: el.attachments, getScope, showError });
  const addImages = attachments.add, clearImages = attachments.clear;
  const historyWindow = createMessageWindow();
  const captureLiveContext = () => agentClient?.captureContext?.({ allowTransition: true }) || (() => true);
  const snapshotRecovery = createSnapshotRecovery({ sync: syncMessagesFromAgent, captureContext: captureLiveContext });
  const responseFallback = createResponseFallback({
    readSnapshot: (options) => agentClient.getSnapshot(options),
    lastEventAt: () => state.lastAgentEventAt || 0,
    applySnapshot: (snapshot) => {
      if (snapshot.current?.() === false) return;
      agentClient.applyAgentState(snapshot.state || {});
      updateStateFromAgent(snapshot.state || {});
      if (snapshot.turnFiles) setTurnFiles(snapshot.turnFiles);
      if (Array.isArray(snapshot.messages)) renderMessages(snapshot.messages, { forceScroll: false });
    },
  });
  let restoringHistory = false;
  let previousTop = 0;
  el.messages.addEventListener("scroll", () => {
    const top = el.messages.scrollTop;
    const scrollingUp = top < previousTop;
    previousTop = top;
    if (el.messages.dataset?.readingAdjustment || el.messages.dataset?.directoryJump) return;
    const distance = el.messages.scrollHeight - el.messages.clientHeight - top;
    stickToMessageBottom = distance <= MESSAGE_BOTTOM_THRESHOLD;
    if (scrollingUp && !restoringHistory) loadEarlierMessages();
  }, { passive: true });
  el.messages.addEventListener("wheel", (event) => {
    if (event.deltaY < 0) { stickToMessageBottom = false; loadEarlierMessages(); }
  }, { passive: true });
  Object.defineProperty(state, "turnFiles", { get: getTurnFiles });
const finishHistoryRestore = () => afterHistoryRestore(el.messages, (top) => { previousTop = top; restoringHistory = false; });
function loadEarlierMessages(force = false) {
  if (restoringHistory) return "pending";
  if (!historyWindow.hasPrevious()) return "end";
  if (!force && el.messages.scrollTop > HISTORY_TOP_THRESHOLD) return "idle";
  restoringHistory = true; stickToMessageBottom = false;
  prependPreviousMessages(historyWindow, el.messages, (message, index) => createMessageNode(message, { index }), () => execution?.refresh());
  finishHistoryRestore(); return "loaded";
}

function createLiveAssistant(message) {
  if (state.live?.current?.() === false) {
    if (state.live.renderFrame) cancelAnimationFrame(state.live.renderFrame);
    state.live.node.remove(); state.live = null;
  }
  if (state.live?.node?.isConnected) return;
  const node = createMessageShell("assistant");
  const content = Array.isArray(message?.content) ? message.content : [];
  const tools = new Map(content.filter(p=>p.type==='toolCall').map((p,i)=>[p.id || `tool-${i}`,{name:p.name || 'tool',args:JSON.stringify(p.arguments || {},null,2),arguments:p.arguments}]));
  state.live = { node, bubble: node.querySelector(".bubble"), text: content.filter(p=>p.type==='text').map(p=>p.text || '').join(''), thinking: content.filter(p=>p.type==='thinking').map(p=>p.thinking || '').join(''), tools, toolNodes:new Map(), dirtyTools:new Set(tools.keys()), executionDirty:true, snapshot: message, renderFrame: null, current: captureLiveContext() };
  el.messages.append(node);
  renderLiveAssistant();
  scrollBottom();
}

function applyDelta(delta) {
  createLiveAssistant({ role: "assistant", content: [] });
  if (!state.live) return;
  if (delta.type === "text_delta") state.live.text += delta.delta || "";
  if (delta.type === "text_end" && typeof delta.content === "string") state.live.text = delta.content;
  if (delta.type === "thinking_delta") state.live.thinking += delta.delta || "";
  if (delta.type === "thinking_end" && typeof delta.content === "string") state.live.thinking = delta.content;
  if (delta.type === "toolcall_start") {
    const key = delta.id || `tool-${state.live.tools.size}`;
    state.live.tools.set(key, { name: delta.toolName || "tool", args: "" }); state.live.dirtyTools.add(key);
  }
  if (delta.type === "toolcall_delta") {
    const key = delta.id || [...state.live.tools.keys()].at(-1);
    const tool = state.live.tools.get(key);
    if (tool) { tool.args += delta.delta || ""; state.live.dirtyTools.add(key); }
  }
  if (delta.type === "toolcall_end" && delta.toolCall) {
    const key = delta.toolCall.id || [...state.live.tools.keys()].at(-1);
    state.live.tools.set(key, { name: delta.toolCall.name || delta.toolCall.toolName || "tool", args: JSON.stringify(delta.toolCall.arguments || {}, null, 2), arguments:delta.toolCall.arguments });
    state.live.dirtyTools.add(key); state.live.executionDirty = true;
  }
  scheduleLiveAssistantRender();
}

function scheduleLiveAssistantRender() {
  const live = state.live;
  if (!live || live.renderFrame) return;
  live.renderFrame = requestAnimationFrame(() => {
    if (!state.live || state.live !== live) return;
    live.renderFrame = null;
    renderLiveAssistant({filesChanged:false});
    scrollBottom();
  });
}

function renderLiveAssistant({filesChanged = true} = {}) {
  const live = state.live; if (!live) return;
  const update = () => renderLiveAssistantContent(filesChanged);
  if (!execution) { update(); return; }
  const readers = [...live.dirtyTools].map(key=>live.toolNodes.get(key)?.body).filter(Boolean);
  if (!stickToMessageBottom) readers.unshift(el.messages);
  if (live.executionDirty || filesChanged) execution.change(update);
  else if (readers.length) preserveReadingPositions(readers,update);
  else update();
}
function renderLiveAssistantContent(filesChanged) {
  const live = state.live;
  if (!live) return;
  let structure = live.executionDirty; live.executionDirty = false;
  if (live.thinking && !live.thinkingNode) {
    live.thinkingNode = document.createElement('details'); live.thinkingNode.className='thinking';
    const summary=document.createElement('summary');summary.textContent='思考过程';
    live.thinkingBody=document.createElement('div');live.thinkingNode.append(summary,live.thinkingBody);live.bubble.append(live.thinkingNode);structure=true;
  }
  if (live.thinkingBody && live.renderedThinking !== live.thinking) {updateStreamingText(live.thinkingBody,live.thinking);live.renderedThinking=live.thinking;}
  if (live.text && !live.textNode) {
    live.textNode=document.createElement('div');live.bubble.append(live.textNode);
    live.markdown=createStreamingMarkdown(live.textNode,renderMarkdown,{onNotice:showNotice});structure=true;
  }
  live.markdown?.update(live.text);
  for (const key of live.dirtyTools) {
    const tool=live.tools.get(key); if(!tool)continue;
    let item=live.toolNodes.get(key);
    if(!item){const node=createToolCard(tool.name,tool.args);item={node,body:node.querySelector('.tool-result'),title:node.querySelector('b')};live.toolNodes.set(key,item);live.bubble.append(node);structure=true;}
    if(item.body.textContent!==tool.args)updateStreamingText(item.body,tool.args);
    const title=`工具 · ${displayToolName(tool.name)}`;if(item.title.textContent!==title)item.title.textContent=title;
  }
  live.dirtyTools.clear();
  if(filesChanged){
    const signature=JSON.stringify([state.turnFiles,(state.turnFiles.modified || []).map(file=>execution?.isConfirmedFile(file))]);
    if(signature!==live.filesSignature){live.bubble.querySelector('.turn-files-card')?.remove();appendTurnFilesCard(live.bubble,state.turnFiles);live.filesSignature=signature;structure=true;}
  }
  if(live.text || live.thinking || live.tools.size){live.status?.remove();live.status=null;}
  else if(!live.status){live.status=createAssistantStatus('正在思考…','pending');live.bubble.append(live.status);}
  if (structure) {
    const content=[{type:'thinking',thinking:live.thinking},{type:'text',text:live.text},...[...live.tools].map(([id,tool])=>({type:'toolCall',id,name:tool.name,arguments:tool.arguments}))];
    execution?.register(live.node,{...live.snapshot,role:'assistant',content},undefined,{live:true});execution?.refresh(true);
  }
}

function finalizeMessage(message) {
  if (execution) execution.change(() => finalizeMessageContent(message)); else finalizeMessageContent(message);
}
function finalizeMessageContent(message) {
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
  execution?.refresh(true); scrollBottom();
}

function renderMessages(messages, options = {}) {
  if (!snapshotRecovery.canRender()) return;
  if (execution && options.forceScroll === false) execution.change(() => renderMessagesContent(messages, options)); else renderMessagesContent(messages, options);
  snapshotRecovery.recovered();
}
function renderMessagesContent(messages, { forceScroll = true } = {}) {
  if (forceScroll) cancelReadingAdjustment(el.messages);
  execution?.setMessages(messages, state.running);
  directory?.update(messages);
  replyActions?.syncContext();
  const shouldFollow = forceScroll || stickToMessageBottom;
  const previousScrollTop = el.messages.scrollTop;
  if (state.live?.renderFrame) cancelAnimationFrame(state.live.renderFrame);
  state.live = null;
  el.messages.replaceChildren();
  if (!messages.length) {
    historyWindow.clear();
    const welcome = document.createElement("div");
    welcome.className = "welcome";
    welcome.innerHTML = '<img src="/baodan-assistant.png" alt="宝蛋"><h1>我已就绪</h1><p>来了！我是帮你搬砖的宝蛋，可以在设置里配置模型和skill哦~</p>';
    el.messages.append(welcome);
    return;
  }
  restoringHistory = true;
  const page = historyWindow.update(messages, { reset: forceScroll });
  const lastAssistantIndex = messages.findLastIndex((message) => message.role === "assistant");
  const fragment = document.createDocumentFragment();
  page.messages.forEach((message, index) => {
    const turnFiles = index + page.start === lastAssistantIndex && state.turnFiles.involved.length ? state.turnFiles : null;
    fragment.append(createMessageNode(message, { turnFiles, index: page.start + index }));
  });
  el.messages.append(fragment); execution?.refresh();
  if (shouldFollow) scrollBottom("auto", forceScroll);
  else el.messages.scrollTop = previousScrollTop;
  finishHistoryRestore();
}

function createMessageNode(message, { turnFiles = null, index } = {}) {
  const role = message.role === "user" ? "user" : "assistant";
  const node = createMessageShell(role);
  if (index != null) node.dataset.messageIndex = index;
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
  execution?.register(node, message, index);
  replyActions?.attach(node, message);
  return node;
}

function appendTurnFilesCard(container, files) {
  if (!files?.involved?.length || container.querySelector(":scope > .turn-files-card")) return;
  const card = document.createElement("div");
  card.className = "turn-files-card";
  const label = document.createElement("div");
  label.textContent = `本轮涉及文件 ${files.involved.length} 个`;
  card.append(label);
  for (const file of files.involved) {
    const button = document.createElement("button");
    button.textContent = `${execution?.isConfirmedFile(file) ? "已确认修改 · " : ""}${file}`;
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
  if ((sending && sending.scope === getScope()) || attachments.isReading()) { showNotice('正在读取附件或确认发送，请稍候'); return; }
  const instruction = el.promptInput.value.trim();
  if (!instruction && !state.images.length) return;
  try { validatePromptPayload({ message: instruction, images: state.images }); } catch (error) { showError(error); return; }
  const scope = getScope();
  const quoted = replyActions?.take(instruction), message = quoted?.message ?? instruction;
  el.promptInput.value = "";
  resizePrompt();
  const user = { role: "user", content: message || "[图片]" };
  el.messages.querySelector(".welcome")?.remove();
  const userNode = createMessageNode(user); el.messages.append(userNode);
  scrollBottom("auto", true);
  const ticket = attachments.take();
  const images = ticket.items.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
  const sendToken = { scope }; sending = sendToken;
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
    if (scope !== getScope()) return;
    if (error.acceptanceUnknown) { showNotice(error.message, true); return; }
    userNode.remove(); attachments.restore(ticket);
    if (!el.promptInput.value) el.promptInput.value = instruction;
    resizePrompt(); replyActions?.restore(quoted);
    stopResponseFallback();
    if (!wasRunning) {
      state.running = false;
      state.streaming = false;
      updateControls();
    }
    showError(error);
  } finally { if (sending === sendToken) sending = null; }
}

async function compactSession() {
  if (el.compactButton.disabled) return;
  el.compactButton.disabled = true;
  el.compactButton.setAttribute("aria-busy", "true");
  el.compactButton.setAttribute("aria-label", "正在压缩上下文");
  el.compactButton.dataset.tooltip = "正在压缩上下文……";
  try { showNotice("正在压缩上下文……"); await agentClient.compact(); }
  catch (error) { showError(error); }
  finally {
    el.compactButton.disabled = false;
    el.compactButton.removeAttribute("aria-busy");
    el.compactButton.setAttribute("aria-label", "压缩上下文");
    el.compactButton.dataset.tooltip = "压缩上下文";
  }
}

async function syncMessagesFromAgent() {
  try {
    const data = await sessionService.syncCurrent();
    if (!data.current()) return;
    updateStateFromAgent(data.state);
    if (data.turnFiles) setTurnFiles(data.turnFiles);
    renderMessages(data.messages, { forceScroll: false });
  } catch (error) { if (!error.staleResponse) { snapshotRecovery.recovered(); console.warn("同步消息失败", error); } }
}

function startResponseFallback() { responseFallback.start(); }

function stopResponseFallback() { responseFallback.stop(); }

const handleExtensionUi = agentUi.handle;

function clearWorkspaceDraft() {
  agentUi.reset();
  replyActions?.clear();
  stopResponseFallback();
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
  el.runtimeText.closest(".runtime-state").classList.toggle("hidden", !text);
}

function resizePrompt() { el.promptInput.style.height = "auto"; el.promptInput.style.height = `${Math.min(el.promptInput.scrollHeight, 180)}px`; }

function scrollBottom(behavior = "auto", force = false) {
  if (force) { cancelReadingAdjustment(el.messages); stickToMessageBottom = true; }
  if (!force && !stickToMessageBottom) return;
  const epoch = scrollEpoch;
  requestAnimationFrame(() => {
    if (epoch !== scrollEpoch || (!force && !stickToMessageBottom)) return;
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
  return { observeSyncEvent: snapshotRecovery.event, loadDirectoryPage: () => loadEarlierMessages(true), pauseFollow: () => { stickToMessageBottom = false; scrollEpoch += 1; }, isRunning, isStreaming, setRuntimeState, setLastAgentEventAt, settle, toolStarted, toolEnded, imageCount, createLiveAssistant, applyDelta, renderLiveAssistant, finalizeMessage, renderMessages, sendPrompt, compactSession, syncMessagesFromAgent, startResponseFallback, stopResponseFallback, addImages, handleExtensionUi, resetAgentUi:agentUi.reset, clearWorkspaceDraft, updateToolStatus, setRuntime, resizePrompt, scrollBottom };
}
