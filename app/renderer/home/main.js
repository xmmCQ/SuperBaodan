import "/core/desktop-status.js?v=1";
import { createUiDialogController } from "/ui-dialog.js?v=5";
import { createWorkApps } from './work-apps.js';
import { createWorkDocuments } from './work-documents.js?v=ui1';
import { setIconBusy } from "/icons.js?v=2";
import { createWorkspaceSwitcher } from "/workspace-switcher.js?v=5";
import { renderMarkdown } from "/markdown-renderer.js?v=2";
import { invoke } from "/core/service-client.js?v=1";
import { createAgentClient } from "/core/agent-client.js?v=1";
import { createAgentEventStream } from "/core/event-stream.js?v=1";
import { createSessionService } from "/core/session-service.js?v=1";
import { createSessionSearch } from "/core/session-search.js";
import { createReadingSettings } from "/core/reading-settings.js";
import { createReplyActions } from "/core/reply-actions.js";
import { createConversationDirectory } from "/core/conversation-directory.js";
import { createHomeState } from "/home/state.js?v=1";
import { createCalendar } from "/home/calendar.js?v=1";
import { createDashboard } from "/home/dashboard.js?v=1";
import { createTasks } from "/home/tasks.js?v=1";
import { createDayView } from "/home/day-view.js?v=1";
import { createDailyRecords } from "/home/daily-records.js?v=1";
import { createRecordEditor } from "/home/record-editor.js?v=1";
import { createHomeChat } from "/home/home-chat.js?v=3";
import { createVSkills } from "/home/vskills.js?v=1";
import { createHomeSettings } from './settings.js';
import { createDayLoader } from './day-loader.js';
import { createAgentRecovery } from '../core/agent-ui.js';
import { createModelCatalogSync } from '../core/model-catalog-sync.js';

const state = createHomeState(toLocalDate(new Date()));
const el = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));
const reading = createReadingSettings({ container: el.chatMessages, onNotice: toast });
const uiDialogs = createUiDialogController({
  dialog: el.uiDialog, form: el.uiDialogForm, title: el.uiDialogTitle,
  message: el.uiDialogMessage, field: el.uiDialogField,
  closeButton: el.uiDialogClose, cancelButton: el.uiDialogCancel, confirmButton: el.uiDialogConfirm,
});

createWorkApps({ trigger: el.openAppsButton, invoke, uiDialogs, toast, escapeHtml, openAll: openWorkApps });
createWorkDocuments({ trigger: el.workDocumentsButton, invoke, uiDialogs });

let homeChat;
let homeSettings;
let vskills;
let historySearch;
const workspaceSwitcher = createWorkspaceSwitcher({
  trigger: el.workspaceSwitcher,
  invoke,
  uiDialogs,
  hasDraft: () => Boolean(el.chatInput.value.trim() || homeSettings?.hasDraft()),
  getDraftWarning: () => homeSettings?.hasDraft() ? '切换项目将放弃未保存的项目提示词，并清空未发送的消息。' : '切换工作区将清空当前未发送的内容。',
  clearDraft: () => { el.chatInput.value = ""; homeChat?.autoResizeInput(); homeSettings?.discard(); },
  onActivating: () => agentClient.beginTransition(),
  onActivated: ({ workspace }) => {
    historySearch?.reset();
    homeChat?.setWorkspace(workspace);
    homeSettings?.contextChanged();
    homeChat?.scheduleHomeWorkspaceReload(`已切换到工作区：${workspace.name}`);
  },
  onActivationFailed: () => homeChat?.syncHomeChatMessages(),
  onError: (error) => toast(error?.message || String(error), true),
});
const currentWorkspaceId = () => homeChat?.workspace()?.id || null;
const agentClient = createAgentClient({ getWorkspaceId: currentWorkspaceId });
const sessionService = createSessionService({ agentClient, getWorkspaceId: currentWorkspaceId });
const replyActions = createReplyActions({ container: el.chatMessages, input: el.chatInput, quoteBox: el.replyQuote, getScope: () => `${currentWorkspaceId()}:${state.chat.activeSessionId}`, onNotice: toast });
const directory = createConversationDirectory({ button: el.directoryButton, container: el.chatMessages, getScope: () => `${currentWorkspaceId()}:${state.chat.activeSessionId}`, loadEarlier: () => homeChat.loadDirectoryPage(), pauseFollow: () => homeChat.pauseFollow(), onLatest: () => homeChat.scrollChat(true), onNotice: toast });

const dayView = createDayView({ state: state.records, elements: el });
let dashboard;
let dailyRecords;
const loadDashboardViews = async (...args) => {
  const [loaded] = await Promise.all([dashboard.loadDashboard(...args), dailyRecords.loadMonth(state.planner.month)]);
  return loaded;
};
const loadDayView = createDayLoader({
  prepareTasks: date => dashboard.prepareDay(date),
  prepareRecords: date => dailyRecords.prepareDate(date),
  commitDate: date => { el.selectedDateTitle.textContent = formatChineseDate(date); },
  setLoading(loading) {
    state.planner.dayLoading = loading;
    dayView.setLoading(loading);
    if (loading) tasks.resetTaskDrag();
    else {
      state.planner.requestedDate = state.records.requestedDate = null;
      calendar.renderCalendar();
      dailyRecords.resumeSearch();
    }
  },
  showNotice: dayView.showNotice,
  retry: date => loadSelectedDay(date),
});
const loadSelectedDay = async (date) => {
  const monthChanged = date.slice(0, 7) !== state.planner.month;
  const loaded = await loadDayView(date);
  if (loaded !== undefined && monthChanged && date === state.planner.selectedDate && date.slice(0, 7) === state.planner.month) await dailyRecords.loadMonth(state.planner.month);
  return loaded;
};
const calendar = createCalendar({
  state: state.planner, elements: el, invoke, toLocalDate, formatChineseDate,
  loadDay: loadSelectedDay,
  recordCountForDate: (date) => dailyRecords?.recordCountForDate(date) || 0,
});
const tasks = createTasks({
  state: state.planner, elements: el, invoke, toast, emptyState, escapeHtml, formatChineseDate, toLocalDate,
  loadDashboard: loadDashboardViews,
  loadDay: loadSelectedDay,
});
dashboard = createDashboard({
  state: state.planner, elements: el, invoke,
  rememberTasks: tasks.rememberTasks,
  renderTodayLabel,
  renderCalendar: calendar.renderCalendar,
  renderOverdue: tasks.renderOverdue,
  renderLongTerm: tasks.renderLongTerm,
  toast,
  renderTaskList: tasks.renderTaskList,
  dayTaskMeta: tasks.dayTaskMeta,
  setTaskCount: dayView.setTaskCount,
});
const recordEditor = createRecordEditor({
  state: state.records, elements: el, invoke, uiDialogs, renderMarkdown, toast,
  onSaved: (...args) => dailyRecords.afterSaved(...args),
  onConflict: (...args) => dailyRecords.refreshConflict(...args),
});
dailyRecords = createDailyRecords({
  state: state.records, elements: el, invoke, dayView, editor: recordEditor, renderMarkdown, toast, uiDialogs, escapeHtml,
  renderCalendar: calendar.renderCalendar,
  getSelectedDate: () => state.planner.requestedDate || state.planner.selectedDate,
  getMonth: () => state.planner.month,
  navigateToDate: loadSelectedDay,
  getChatBusy: () => homeChat?.isBusy() || false,
  sendChat: (...args) => homeChat.sendChat(...args),
});

homeChat = createHomeChat({
  state: state.chat, elements: el, invoke, agentClient, sessionService, replyActions, directory, workspaceSwitcher,
  renderMarkdown, toast, escapeHtml, formatDateTime, loadingState, uiDialogs,
  closeVSkillDrawer: () => vskills?.closeVSkillDrawer(),
});
homeSettings = createHomeSettings({ trigger: el.homeSettingsButton, elements: el, invoke, agentClient,
  getWorkspace: homeChat.workspace, loadBootstrap: homeChat.loadHomeChatBootstrap, reading, showNotice: toast, onCatalogChanged: homeChat.applyModelCatalog });
historySearch = createSessionSearch({
  input: el.historySearchInput, results: el.historySearchResults, defaultList: el.chatHistoryList,
  search: sessionService.search, getWorkspaceId: currentWorkspaceId,
  onOpen: async (hit) => {
    if (homeChat.isBusy()) throw new Error("请等待当前任务完成后再打开历史会话");
    await sessionService.activate(hit.sessionPath);
    await homeChat.loadHomeChatBootstrap();
    toast(hit.messageIndex == null ? "已打开会话，命中片段保留在搜索结果中" : `已打开会话，命中第${hit.messageIndex + 1}条历史消息`);
  },
});
el.closeChatHistoryButton.addEventListener("click", historySearch.cancel);
el.openChatHistoryButton.addEventListener("click", historySearch.refresh);
vskills = createVSkills({
  state: state.vskills, elements: el, invoke, uiDialogs, toast, escapeHtml,
  getChatBusy: homeChat.isBusy,
  sendChat: homeChat.sendChat,
  closeChatHistory: homeChat.closeChatHistory,
});

const modelCatalogSync = createModelCatalogSync({scope:currentWorkspaceId,capture:agentClient.captureWorkspace,read:()=>invoke('models.catalog',{}),apply:homeSettings.applyModelCatalog,onError:error=>toast(error.message,true)});
const agentRecovery=createAgentRecovery({mount:el.chatForm.parentElement,client:agentClient,reload:homeChat.loadHomeChatBootstrap,notice:toast});
const agentEvents = createAgentEventStream({
  captureContext: () => agentClient.captureContext({ allowTransition: true }),
  onEvent: (event) => {
    agentRecovery.event(event);
    if (event.type === 'models_changed') { void modelCatalogSync.receive(event); return; }
    if (event.type === "workspace_changed" && !event.renamed) historySearch.reset();
    homeChat.handleHomeChatEvent(event);
    if (event.type === 'workspace_changed') homeSettings.contextChanged();
  },
  onStatus: (status, detail) => {
    if (status === "open" && detail.reconnected) {
      void homeChat.syncHomeChatMessages();
      void homeChat.loadAgentStatus();
    } else if (status === "reconnecting") homeChat.setAgentStatus("事件连接中断，正在重连", "error");
    else if (status === "parse_error") console.warn("首页助手事件解析失败", detail.error);
  },
});

const startupRevealTimer = setTimeout(revealHome, 3000);
void start().catch((error) => console.error("主页初始化失败", error)).finally(revealHome);

async function start() {
  bindEvents();
  agentEvents.connect();
  renderTodayLabel();
  // Work records are local, shared data: never wait for workspace or Agent startup.
  const dayReady = loadSelectedDay(state.planner.selectedDate).finally(revealHome);
  const dashboardReady = loadDashboardViews();
  void vskills.loadVSkills().catch(error => toast(error.message, true));
  void prepareAssistant();
  setInterval(homeChat.loadAgentStatus, 12000);
  await Promise.all([dayReady, dashboardReady]);
}

async function prepareAssistant() {
  try {
    await workspaceSwitcher.load();
    homeChat.setWorkspace(workspaceSwitcher.active());
    await homeChat.warmupAgent();
    await homeChat.loadHomeChatBootstrap();
  } catch (error) {
    toast(`助手准备失败，工作日历仍可使用：${error.message}`, true);
  }
}

function revealHome() {
  clearTimeout(startupRevealTimer);
  if (!document.documentElement.classList.contains("app-loading")) return;
  document.documentElement.classList.remove("app-loading");
  document.documentElement.classList.add("app-ready");
  document.body.setAttribute("aria-busy", "false");
}

function bindEvents() {
  el.prevMonth.addEventListener("click", () => tasks.changeMonth(-1));
  el.nextMonth.addEventListener("click", () => tasks.changeMonth(1));
  el.todayButton.addEventListener("click", async () => {
    state.planner.month = state.planner.today.slice(0, 7);
    await Promise.all([loadSelectedDay(state.planner.today), loadDashboardViews()]);
  });
  el.refreshButton.addEventListener("click", async () => {
    setIconBusy(el.refreshButton, true);
    try { await loadDashboardViews(true); await loadSelectedDay(state.planner.requestedDate || state.planner.selectedDate); }
    finally { setIconBusy(el.refreshButton, false); }
  });
  el.dayTasksTab.addEventListener("click", () => dayView.setActive("tasks"));
  el.dailyRecordsTab.addEventListener("click", () => dayView.setActive("records"));
  el.newTaskButton.addEventListener("click", () => tasks.openTaskModal(null, 'daily'));
  el.newLongtermTaskButton.addEventListener('click', () => {
    el.newLongtermTaskButton.focus();
    tasks.openTaskModal(null, 'longterm');
  });
  el.newDailyRecordButton.addEventListener("click", dailyRecords.openNew);
  el.dailyRecordList.addEventListener("click", dailyRecords.handleListClick);
  el.dailyRecordSearch.addEventListener("input", dailyRecords.scheduleSearch);
  el.clearDailyRecordSearch.addEventListener("click", dailyRecords.clearSearch);
  el.dailyRecordForm.addEventListener("submit", recordEditor.submit);
  el.dailyRecordType.addEventListener("change", recordEditor.handleTypeChange);
  el.dailyRecordContent.addEventListener("input", recordEditor.queuePreview);
  el.closeDailyRecordModal.addEventListener("click", () => void recordEditor.requestClose());
  el.cancelDailyRecordButton.addEventListener("click", () => void recordEditor.requestClose());
  el.dailyRecordModal.addEventListener("click", (event) => { if (event.target === el.dailyRecordModal) void recordEditor.requestClose(); });
  el.closeTaskModal.addEventListener("click", tasks.closeTaskModal);
  el.cancelTaskButton.addEventListener("click", tasks.closeTaskModal);
  el.taskForm.addEventListener("submit", tasks.saveTaskForm);
  [el.taskPlannedDate, el.taskDueDate, el.taskStartDate, el.taskEndDate].forEach((input) => {
    input.addEventListener("click", () => tasks.openTaskDatePicker(input));
    input.addEventListener("keydown", (event) => {
      if (["Enter", " ", "ArrowDown"].includes(event.key)) { event.preventDefault(); tasks.openTaskDatePicker(input); }
    });
  });
  el.datePickerPrev.addEventListener("click", () => tasks.changeTaskDatePickerMonth(-1));
  el.datePickerNext.addEventListener("click", () => tasks.changeTaskDatePickerMonth(1));
  el.datePickerGrid.addEventListener("click", tasks.selectTaskDate);
  el.datePickerClear.addEventListener("click", tasks.clearTaskDate);
  el.taskForm.addEventListener("click", (event) => { if (!event.target.closest(".date-field, .task-date-picker")) tasks.closeTaskDatePicker(); });
  el.taskModal.addEventListener("click", (event) => { if (event.target === el.taskModal) tasks.closeTaskModal(); });
  [el.dayTasks, el.overdueTasks, el.longtermTasks].forEach((container) => container.addEventListener("click", tasks.handleTaskListClick));
  el.dayTasks.addEventListener("dragstart", tasks.handleTaskDragStart);
  el.dayTasks.addEventListener("dragend", tasks.resetTaskDrag);
  el.calendarGrid.addEventListener("dragover", tasks.handleCalendarDragOver);
  el.calendarGrid.addEventListener("drop", tasks.handleCalendarDrop);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (recordEditor.isOpen()) void recordEditor.requestClose();
    else if (!el.taskDatePicker.classList.contains("hidden")) tasks.closeTaskDatePicker();
    else if (!el.taskModal.classList.contains("hidden")) tasks.closeTaskModal();
    else if (!el.vskillForm.classList.contains("hidden")) vskills.closeVSkillForm();
    else if (!el.vskillDrawer.classList.contains("hidden")) vskills.closeVSkillDrawer();
    else if (!el.chatHistoryDrawer.classList.contains("hidden")) homeChat.closeChatHistory();
  });
  el.closeAppsModal.addEventListener("click", () => el.appsModal.classList.add("hidden"));
  el.appsModal.addEventListener("click", (event) => { if (event.target === el.appsModal) el.appsModal.classList.add("hidden"); });
  el.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (homeChat.isBusy()) return void homeChat.stopHomeChat();
    const message = el.chatInput.value.trim();
    if (message) void homeChat.sendChat(message);
  });
  el.chatInput.addEventListener("input", homeChat.autoResizeInput);
  el.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!homeChat.isBusy()) el.chatForm.requestSubmit(); }
  });
  el.expandAssistantButton.addEventListener("click", homeChat.openAssistantWorkspace);
  el.homeSettingsButton.addEventListener('click', homeSettings.open);
  el.openVSkillButton.addEventListener("click", vskills.openVSkillDrawer);
  el.closeVSkillButton.addEventListener("click", vskills.closeVSkillDrawer);
  el.newVSkillButton.addEventListener("click", () => vskills.openVSkillForm());
  el.cancelVSkillButton.addEventListener("click", vskills.closeVSkillForm);
  el.vskillForm.addEventListener("submit", vskills.saveVSkill);
  el.vskillList.addEventListener("click", vskills.handleVSkillListClick);
  el.vskillQuickbar.addEventListener("click", vskills.handleVSkillQuickClick);
  el.openChatHistoryButton.addEventListener("click", homeChat.openChatHistory);
  el.newChatButton.addEventListener("click", homeChat.newHomeChat);
  el.historyNewChatButton.addEventListener("click", homeChat.newHomeChat);
  el.closeChatHistoryButton.addEventListener("click", homeChat.closeChatHistory);
  el.historySessionsTab.addEventListener("click", () => homeChat.switchHistoryTab("sessions"));
  el.chatHistoryList.addEventListener("click", homeChat.handleHistoryClick);
  el.chatHistoryList.addEventListener("submit", homeChat.handleHistoryRenameSubmit);
  window.addEventListener("focus", () => { void tasks.refreshTaskViews(); void homeChat.syncHomeChatMessages(); });
}

async function openWorkApps() {
  setIconBusy(el.openAppsButton, true);
  try {
    const data = await invoke("apps.openAll", {});
    el.appsResults.innerHTML = data.results.map((item) => `<div class="app-result ${item.status === "failed" ? "failed" : ""}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.message)}</span></div>`).join("") + (data.warning ? `<p class="form-hint">${escapeHtml(data.warning)}</p>` : '');
    el.appsModal.classList.remove("hidden");
  } catch (error) { toast(error.message, true); }
  finally { setIconBusy(el.openAppsButton, false); }
}

function renderTodayLabel() {
  const date = parseLocalDate(state.planner.today);
  el.todayLabel.textContent = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 · 星期${"日一二三四五六"[date.getDay()]}`;
}
function emptyState(text, icon) { return `<div class="empty-state"><span>${icon}</span>${escapeHtml(text)}</div>`; }
function loadingState() { return '<div class="empty-state"><span>· · ·</span>正在读取</div>'; }
function toast(message, isError = false) {
  const node = document.createElement("div"); node.className = `toast ${isError ? "error" : ""}`; node.textContent = message;
  el.toastContainer.appendChild(node); setTimeout(() => node.remove(), 3800);
}
function toLocalDate(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function parseLocalDate(value) { const [year, month, day] = value.split("-").map(Number); return new Date(year, month - 1, day); }
function formatChineseDate(value) { const date = parseLocalDate(value); return `${date.getMonth() + 1}月${date.getDate()}日 · 周${"日一二三四五六"[date.getDay()]}`; }
function formatDateTime(date) { return Number.isNaN(date.getTime()) ? "未知" : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
