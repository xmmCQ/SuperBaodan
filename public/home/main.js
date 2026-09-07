import { createUiDialogController } from "/ui-dialog.js?v=5";
import { setIconBusy } from "/icons.js?v=2";
import { createWorkspaceSwitcher } from "/workspace-switcher.js?v=5";
import { renderMarkdown } from "/markdown-renderer.js?v=2";
import { api } from "/core/api-client.js?v=1";
import { createAgentClient } from "/core/agent-client.js?v=1";
import { createAgentEventStream } from "/core/event-stream.js?v=1";
import { createSessionService } from "/core/session-service.js?v=1";
import { createHomeState } from "/home/state.js?v=1";
import { createCalendar } from "/home/calendar.js?v=1";
import { createDashboard } from "/home/dashboard.js?v=1";
import { createTasks } from "/home/tasks.js?v=1";
import { createDayView } from "/home/day-view.js?v=1";
import { createDailyRecords } from "/home/daily-records.js?v=1";
import { createRecordEditor } from "/home/record-editor.js?v=1";
import { createHomeChat } from "/home/home-chat.js?v=2";
import { createVSkills } from "/home/vskills.js?v=1";

const state = createHomeState(toLocalDate(new Date()));
const el = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));
const uiDialogs = createUiDialogController({
  dialog: el.uiDialog, form: el.uiDialogForm, title: el.uiDialogTitle,
  message: el.uiDialogMessage, field: el.uiDialogField,
  closeButton: el.uiDialogClose, cancelButton: el.uiDialogCancel, confirmButton: el.uiDialogConfirm,
});

let homeChat;
let vskills;
const workspaceSwitcher = createWorkspaceSwitcher({
  trigger: el.workspaceSwitcher,
  api,
  uiDialogs,
  hasDraft: () => Boolean(el.chatInput.value.trim()),
  clearDraft: () => { el.chatInput.value = ""; homeChat?.autoResizeInput(); },
  onActivated: ({ workspace }) => {
    homeChat?.setWorkspace(workspace);
    homeChat?.scheduleHomeWorkspaceReload(`已切换到工作区：${workspace.name}`);
  },
  onError: (error) => toast(error?.message || String(error), true),
});
const currentWorkspaceId = () => homeChat?.workspace()?.id || null;
const agentClient = createAgentClient({ getWorkspaceId: currentWorkspaceId });
const sessionService = createSessionService({ agentClient, getWorkspaceId: currentWorkspaceId });

const dayView = createDayView({ state: state.records, elements: el });
let dashboard;
let dailyRecords;
const loadDashboardViews = async (...args) => Promise.all([dashboard.loadDashboard(...args), dailyRecords.loadMonth(state.planner.month)]);
const loadSelectedDay = async (date) => {
  const monthChanged = date.slice(0, 7) !== state.planner.month;
  await Promise.all([dashboard.loadDay(date), dailyRecords.loadDate(date)]);
  if (monthChanged) await dailyRecords.loadMonth(state.planner.month);
};
const calendar = createCalendar({
  state: state.planner, elements: el, toLocalDate, formatChineseDate,
  loadDay: loadSelectedDay,
  recordCountForDate: (date) => dailyRecords?.recordCountForDate(date) || 0,
});
const tasks = createTasks({
  state: state.planner, elements: el, api, toast, emptyState, escapeHtml, formatChineseDate, toLocalDate,
  loadDashboard: loadDashboardViews,
  loadDay: loadSelectedDay,
});
dashboard = createDashboard({
  state: state.planner, elements: el, api,
  rememberTasks: tasks.rememberTasks,
  renderTodayLabel,
  renderCalendar: calendar.renderCalendar,
  renderOverdue: tasks.renderOverdue,
  renderLongTerm: tasks.renderLongTerm,
  toast, formatChineseDate, loadingState,
  renderTaskList: tasks.renderTaskList,
  dayTaskMeta: tasks.dayTaskMeta,
  emptyState,
  setTaskCount: dayView.setTaskCount,
});
const recordEditor = createRecordEditor({
  state: state.records, elements: el, api, uiDialogs, renderMarkdown, toast,
  onSaved: (...args) => dailyRecords.afterSaved(...args),
  onConflict: (...args) => dailyRecords.refreshConflict(...args),
});
dailyRecords = createDailyRecords({
  state: state.records, elements: el, api, dayView, editor: recordEditor, renderMarkdown, toast, uiDialogs, escapeHtml,
  renderCalendar: calendar.renderCalendar,
  getSelectedDate: () => state.planner.selectedDate,
  getMonth: () => state.planner.month,
  navigateToDate: loadSelectedDay,
  getChatBusy: () => homeChat?.isBusy() || false,
  sendChat: (...args) => homeChat.sendChat(...args),
});

homeChat = createHomeChat({
  state: state.chat, elements: el, api, agentClient, sessionService, workspaceSwitcher,
  renderMarkdown, toast, escapeHtml, formatDateTime, loadingState, uiDialogs,
  closeVSkillDrawer: () => vskills?.closeVSkillDrawer(),
});
vskills = createVSkills({
  state: state.vskills, elements: el, api, uiDialogs, toast, escapeHtml,
  getChatBusy: homeChat.isBusy,
  sendChat: homeChat.sendChat,
  closeChatHistory: homeChat.closeChatHistory,
});

const agentEvents = createAgentEventStream({
  onEvent: homeChat.handleHomeChatEvent,
  onStatus: (status, detail) => {
    if (status === "open" && detail.reconnected) {
      if (!homeChat.isBusy()) void homeChat.syncHomeChatMessages();
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
  await workspaceSwitcher.load();
  homeChat.setWorkspace(workspaceSwitcher.active());
  await Promise.all([loadDashboardViews(), homeChat.warmupAgent(), vskills.loadVSkills()]);
  await Promise.all([loadSelectedDay(state.planner.selectedDate), homeChat.loadHomeChatBootstrap()]);
  setInterval(homeChat.loadAgentStatus, 12000);
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
    state.planner.selectedDate = state.planner.today;
    await loadDashboardViews();
    await loadSelectedDay(state.planner.selectedDate);
  });
  el.refreshButton.addEventListener("click", async () => {
    setIconBusy(el.refreshButton, true);
    try { await loadDashboardViews(true); await loadSelectedDay(state.planner.selectedDate); }
    finally { setIconBusy(el.refreshButton, false); }
  });
  el.openAppsButton.addEventListener("click", openWorkApps);
  el.exitWorkbenchButton.addEventListener("click", exitWorkbench);
  el.dayTasksTab.addEventListener("click", () => dayView.setActive("tasks"));
  el.dailyRecordsTab.addEventListener("click", () => dayView.setActive("records"));
  el.newTaskButton.addEventListener("click", () => tasks.openTaskModal());
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
  [el.taskPlannedDate, el.taskDueDate].forEach((input) => {
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

async function exitWorkbench() {
  if (!await uiDialogs.confirm("Windows Pi 和后台服务将同时关闭。", { title: "确定退出工作台吗？", danger: true, confirmText: "退出" })) return;
  const shutdownIcon = document.querySelector(".brand-mark img")?.cloneNode(true);
  setIconBusy(el.exitWorkbenchButton, true);
  try { await api("/api/system/shutdown", { method: "POST" }); } catch {}
  const main = document.createElement("main"); main.className = "shutdown-screen";
  const content = document.createElement("div"); if (shutdownIcon) content.append(shutdownIcon);
  const title = document.createElement("h1"); title.textContent = "工作台已退出";
  const message = document.createElement("p"); message.textContent = "Windows Pi 和后台服务已关闭，可以关闭此窗口。";
  content.append(title, message); main.append(content); document.body.replaceChildren(main);
}

async function openWorkApps() {
  setIconBusy(el.openAppsButton, true);
  try {
    const data = await api("/api/apps/open-all", { method: "POST" });
    el.appsResults.innerHTML = data.results.map((item) => `<div class="app-result ${item.status === "failed" ? "failed" : ""}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.message)}</span></div>`).join("");
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
