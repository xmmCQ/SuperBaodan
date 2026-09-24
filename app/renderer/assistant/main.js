import "/core/desktop-status.js?v=1";
import { createUiDialogController } from "/ui-dialog.js?v=5";
import { setIconBusy } from "/icons.js?v=2";
import { createWorkspaceSwitcher } from "/workspace-switcher.js?v=5";
import { createMarkdownArticle, markdownBodyWithoutFrontmatter, renderMarkdown } from "/markdown-renderer.js?v=2";
import { invoke, workspacePayload as addWorkspacePayload, scopedResource as addScopedResource } from "/core/service-client.js?v=1";
import { createAgentClient } from "/core/agent-client.js?v=1";
import { createAgentEventStream } from "/core/event-stream.js?v=1";
import { createSessionService } from "/core/session-service.js?v=1";
import { createAssistantState } from "/assistant/state.js?v=1";
import { createChatView } from "/assistant/chat-view.js?v=4";
import { createReplyActions } from "/core/reply-actions.js";
import { createConversationDirectory } from "/core/conversation-directory.js";
import { createExecutionProcess } from "/core/execution-process.js";
import { createSessionsView } from "/assistant/sessions-view.js?v=3";
import { createSettingsPanel } from './settings-panel.js';
import { createWorkspaceController } from "/assistant/workspace-controller.js?v=2";
import { createBootstrapLoader } from '../core/bootstrap-loader.js';
import { bindModelPicker } from '../core/model-picker-popover.js';
import { createAgentRecovery } from '../core/agent-ui.js';
import { createModelCatalogSync } from '../core/model-catalog-sync.js';

const state = createAssistantState();
const el = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));
const uiDialogs = createUiDialogController({
  dialog: el.uiDialog, form: el.uiDialogForm, title: el.uiDialogTitle,
  message: el.uiDialogMessage, field: el.uiDialogField,
  closeButton: el.uiDialogClose, cancelButton: el.uiDialogCancel, confirmButton: el.uiDialogConfirm,
});

let chat;
let sessions;
let models;
let settings;
let workspace;
let projectPrompt;
const workspaceSwitcher = createWorkspaceSwitcher({
  trigger: el.workspaceSwitcher,
  showPathTooltip: false,
  invoke,
  uiDialogs,
  hasDraft: () => Boolean(el.promptInput.value.trim() || chat?.imageCount() || projectPrompt?.hasDraft()),
  getDraftWarning: () => projectPrompt?.hasDraft() ? '切换项目将放弃未保存的项目提示词，并清空未发送的消息。' : '切换工作区将清空当前未发送的内容。',
  clearDraft: () => { chat?.clearWorkspaceDraft(); projectPrompt?.discard(); },
  onActivating: () => agentClient.beginTransition(),
  onActivated: ({ workspace: active }) => {
    workspace?.setWorkspace(active);
    workspace?.scheduleWorkspaceReload(`已切换到工作区：${active.name}`);
  },
  onActivationFailed: () => chat?.syncMessagesFromAgent(),
  onError: showError,
});
const currentWorkspaceId = () => workspace?.workspace()?.id || null;
const workspacePayload = (payload = {}) => addWorkspacePayload(payload, currentWorkspaceId());
const scopedResource = (url) => addScopedResource(url, currentWorkspaceId());
const agentClient = createAgentClient({ getWorkspaceId: currentWorkspaceId });
const loadBootstrap = createBootstrapLoader({
  client: agentClient, getWorkspaceId: currentWorkspaceId, apply: applyBootstrap,
  beforeLoad() { chat.stopResponseFallback(); chat.setRuntime('正在准备对话……'); },
  onError(error) { chat.setRuntime('对话加载失败，请重试', 'error'); showError(error); },
});
const sessionService = createSessionService({ agentClient, getWorkspaceId: currentWorkspaceId });
const execution = createExecutionProcess({ container: el.messages, getScope: () => `${currentWorkspaceId()}:${state.sessions.currentSessionId}`, getWorkspaceRoot: () => workspace?.workspace()?.root || "" });
const replyActions = createReplyActions({ container: el.messages, input: el.promptInput, quoteBox: el.replyQuote, getScope: () => `${currentWorkspaceId()}:${state.sessions.currentSessionId}`, onNotice: showNotice });
const directory = createConversationDirectory({ button: el.directoryButton, container: el.messages, splitTextBlocks: true, getScope: () => `${currentWorkspaceId()}:${state.sessions.currentSessionId}`, loadEarlier: () => chat.loadDirectoryPage(), pauseFollow: () => chat.pauseFollow(), onLatest: () => chat.scrollBottom("auto", true), onNotice: showNotice });
const command = agentClient.command;

workspace = createWorkspaceController({
  state: state.workspace, elements: el, invoke, scopedResource, workspacePayload, setIconBusy, uiDialogs,
  createMarkdownArticle, showNotice, showError,
  resizePrompt: () => chat?.resizePrompt(),
  loadBootstrap,
});
chat = createChatView({
  state: state.chat, elements: el, agentClient, sessionService, replyActions, directory, execution, command, uiDialogs, renderMarkdown,
  showNotice, showError,
  getTurnFiles: workspace.turnFiles, setTurnFiles: workspace.setTurnFiles,
  getScope: () => `${currentWorkspaceId()}:${state.sessions.currentSessionId || ''}`,
  setWorkspaceOpen: workspace.setWorkspaceOpen,
  previewWorkspaceFile: workspace.previewWorkspaceFile,
  updateStateFromAgent,
});
sessions = createSessionsView({
  state: state.sessions, elements: el, sessionService, uiDialogs, setIconBusy,
  getRunning: chat.isRunning, getWorkspaceId: () => workspace.workspace()?.id, loadBootstrap, showNotice, showError,
});
({ models, projectPrompt, settings } = createSettingsPanel({
  state, elements: el, invoke, command, uiDialogs, showNotice, showError,
  loadBootstrap, updateStateFromAgent, renderMarkdown, markdownBodyWithoutFrontmatter,
  getWorkspace: () => workspace?.workspace(), readingContainer: el.messages,
  captureContext: agentClient.captureContext, capturePreferences: agentClient.captureWorkspace,
}));

const modelCatalogSync = createModelCatalogSync({scope:currentWorkspaceId,capture:agentClient.captureWorkspace,read:()=>invoke('models.catalog',{}),apply:models.acceptModelCatalog,onError:showError});
const agentRecovery=createAgentRecovery({mount:document.querySelector('.composer-wrap'),client:agentClient,reload:loadBootstrap,notice:showNotice});
const agentEvents = createAgentEventStream({
  captureContext: () => agentClient.captureContext({ allowTransition: true }),
  onEvent: (event) => { agentRecovery.event(event); if(['runtime_exit','runtime_stopping'].includes(event.type))chat.resetAgentUi(); chat.setLastAgentEventAt(Date.now()); handleAgentEvent(event); },
  onStatus: (status, detail) => {
    if (status === "open" && detail.reconnected) void chat.syncMessagesFromAgent();
    else if (status === "reconnecting") chat.setRuntime("事件连接中断，正在重连", "error");
    else if (status === "parse_error") console.error(detail.error);
  },
});

let noticeTimer;
void start();

async function start() {
  bindEvents();
  agentEvents.connect();
  const entryUrl = new URL(window.location.href);
  const openSettings = entryUrl.searchParams.get('open') === 'settings';
  if (openSettings) {
    entryUrl.searchParams.delete('open');
    history.replaceState(history.state, '', entryUrl.href);
  }
  await loadBootstrap();
  if (openSettings) el.settingsButton.click();
  const pending = sessionStorage.getItem("super-baodan-pending-prompt");
  if (!pending) return;
  sessionStorage.removeItem("super-baodan-pending-prompt");
  el.promptInput.value = pending;
  await chat.sendPrompt();
}

function bindEvents() {
  el.sendButton.addEventListener("click", chat.sendPrompt);
  el.stopButton.addEventListener("click", () => { execution.event({ type: "stopping" }); agentClient.stop().catch((error) => { execution.event({ type: "stop_failed" }); showError(error); }); });
  el.newSession.addEventListener("click", sessions.newSession);
  el.refreshSessions.addEventListener("click", sessions.refreshSessions);
  el.compactButton.addEventListener("click", chat.compactSession);
  bindModelPicker({ button: el.modelPickerButton, panel: el.modelPickerPanel, filter: el.modelFilter, render: models.renderModelPicker });
  el.settingsButton.addEventListener("click", settings.open);
  el.thinkingSelect.addEventListener("change", models.switchThinking);
  el.attachButton.addEventListener("click", () => el.imageInput.click());
  el.imageInput.addEventListener("change", chat.addImages);
  el.promptInput.addEventListener("input", workspace.handlePromptInput);
  el.showWorkspace.addEventListener("click", workspace.toggleWorkspace);
  el.collapseWorkspace.addEventListener("click", () => workspace.setWorkspaceOpen(false));
  el.refreshWorkspace.addEventListener("click", workspace.loadWorkspaceTree);
  el.uploadWorkspace.addEventListener("click", () => { if (!el.uploadWorkspace.disabled) el.workspaceUploadInput.click(); });
  el.workspaceUploadInput.addEventListener("change", workspace.uploadWorkspaceFiles);
  el.workspaceSearch.addEventListener("input", workspace.searchWorkspaceFiles);
  el.insertPreviewPath.addEventListener("click", () => workspace.insertFileReference(state.workspace.previewPath));
  el.promptInput.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void chat.sendPrompt(); } });
}

async function applyBootstrap(data, current) {
  const enabledModels = await models.resolveEnabledModels(data.enabledModels);
  if (!current()) return;
  workspace.setWorkspace(data.workspace || workspace.workspace());
  if (data.workspaces) workspaceSwitcher.sync(data.workspaces);
  if (data.workspaces?.warning && !sessionStorage.getItem("super-baodan-workspace-warning")) {
    sessionStorage.setItem("super-baodan-workspace-warning", "shown"); showNotice(data.workspaces.warning, true);
  }
  models.setEnabledModels(enabledModels,data.visibleModelKeys);
  sessions.setCurrentSession(data.state?.sessionId);
  chat.setRuntimeState({ running: Boolean(data.state?.isStreaming), streaming: Boolean(data.state?.isStreaming) });
  workspace.setTurnFiles(data.turnFiles);
  chat.renderMessages(data.messages || []);
  models.renderModels(data.models || [], data.state?.model);
  models.renderThinking(data.thinkingLevels || ["off"], data.state?.thinkingLevel || "off");
  sessions.renderSessions(data.sessions || []);
  updateStateFromAgent(data.state || {});
  await workspace.refreshWorkspaceTreeIfOpen();
  if (!current()) return;
  chat.setRuntime(data.state?.isStreaming ? "正在处理……" : "", "ready");
  if (data.state?.isStreaming) chat.startResponseFallback();
}

function handleAgentEvent(event) {
  if (event.type === 'models_changed') { void modelCatalogSync.receive(event); return; }
  const agentState = agentClient.applyEvent(event);
  chat.observeSyncEvent(event);
  switch (event.type) {
    case "connected":
      if (event.workspace) { workspace.setWorkspace(event.workspace); workspaceSwitcher.sync({ workspace: event.workspace }); }
      if (event.state === "error") chat.setRuntime("对话暂不可用，请重试", "error");
      else chat.setRuntime(event.state === "busy" ? "正在处理……" : "", "ready");
      break;
    case "runtime_ready": chat.setRuntime(event.state?.isStreaming ? "正在处理……" : "", "ready"); updateStateFromAgent(event.state || {}); break;
    case "runtime_stopping": chat.setRuntime(""); break;
    case "runtime_idle": chat.setRuntime(""); chat.setRuntimeState(agentState); break;
    case "runtime_stopped": chat.setRuntime(""); break;
    case "runtime_exit":
      chat.setRuntime("对话暂不可用，请重试", "error"); chat.setRuntimeState(agentState);
      showNotice(event.error || "对话连接中断，请重新加载对话", true); break;
    case "agent_start":
      chat.startResponseFallback();
      chat.setRuntimeState(agentState); workspace.setTurnFiles({ involved: [], modified: [] });
      chat.setRuntime("正在处理……", "ready"); break;
    case "message_start": if (event.message?.role === "assistant") chat.createLiveAssistant(event.message); break;
    case "message_update": chat.applyDelta(event.assistantMessageEvent || {}); break;
    case "message_end": chat.finalizeMessage(event.message); break;
    case "tool_execution_start": chat.toolStarted(event.toolCallId, event.toolName); break;
    case "tool_execution_update": chat.updateToolStatus(); break;
    case "tool_execution_end": chat.toolEnded(event.toolCallId); break;
    case "workspace_turn_files": workspace.setTurnFiles(event); chat.renderLiveAssistant(); break;
    case "workspace_changed": {
      if (event.renamed) { workspace.setWorkspace(event.workspace); workspaceSwitcher.sync({ workspace: event.workspace }); break; }
      const hadDraft = Boolean(el.promptInput.value.trim() || chat.imageCount());
      sessions.clearSearch();
      chat.clearWorkspaceDraft(); workspace.setWorkspace(event.workspace); projectPrompt.contextChanged(); workspaceSwitcher.sync({ workspace: event.workspace });
      workspace.scheduleWorkspaceReload(`已切换到工作区：${event.workspace.name}${hadDraft ? "，未发送内容已清空" : ""}`);
      break;
    }
    case "queue_update": {
      const count = (event.steering?.length || 0) + (event.followUp?.length || 0);
      if (count > 0) showNotice(`待处理消息：${count}`);
      break;
    }
    case "compaction_start": showNotice("正在压缩上下文……"); break;
    case "compaction_end": showNotice(event.errorMessage ? `压缩失败：${event.errorMessage}` : "上下文压缩完成"); break;
    case "auto_retry_start": showNotice(`模型请求重试 ${event.attempt}/${event.maxAttempts}`); break;
    case "extension_ui_request": void chat.handleExtensionUi(event); break;
    case "agent_settled":
      chat.settle(agentState); chat.setRuntime("");
      void Promise.all([refreshStateAndSessions(), workspace.refreshWorkspaceTreeIfOpen()]); break;
    case "agent_end": if (!event.willRetry) chat.setRuntime("正在收尾", "ready"); break;
    case "extension_error": showNotice(event.error || "扩展执行失败", true); break;
  }
  execution.event(event);
}

function updateStateFromAgent(agentState) {
  sessions.setCurrentSession(agentState.sessionId || state.sessions.currentSessionId);
  chat.setRuntimeState({ running: Boolean(agentState.isStreaming), streaming: Boolean(agentState.isStreaming) });
  const usage = agentState.contextUsage;
  el.contextMeta.textContent = usage?.percent != null ? `上下文 ${Math.round(usage.percent)}%` : "";
  models.applyAgentState(agentState);
}

async function refreshStateAndSessions() {
  const listCurrent = sessionService.beginListRead();
  try {
    const [synced, listed] = await Promise.all([sessionService.syncCurrent(), sessionService.list()]);
    if (!synced.current()) return;
    updateStateFromAgent(synced.state); if (synced.turnFiles) workspace.setTurnFiles(synced.turnFiles); chat.renderMessages(synced.messages, { forceScroll: false });
    if (listCurrent()) sessions.renderSessions(listed);
  } catch (error) { if (!error.staleResponse) console.warn(error); }
}

function showNotice(message, error = false) {
  if (!message) return;
  clearTimeout(noticeTimer); el.notice.textContent = message; el.notice.style.background = error ? "#9f3535" : "#3a332c"; el.notice.classList.remove("hidden");
  noticeTimer = setTimeout(() => el.notice.classList.add("hidden"), 5000);
}
function showError(error) { showNotice(error?.message || String(error), true); }
