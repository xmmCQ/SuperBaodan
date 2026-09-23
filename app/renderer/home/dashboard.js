import { createReadError } from './read-error.js';

export function createDashboard({
  state,
  elements: el,
  invoke,
  rememberTasks,
  renderTodayLabel,
  renderCalendar,
  renderOverdue,
  renderLongTerm,
  toast,
  renderTaskList,
  dayTaskMeta,
  setTaskCount
}) {
async function loadDashboard(showToast = false) {
  const requestId = ++state.dashboardRequest;
  const month = state.month;
  try {
    const data = await invoke("tasks.dashboard", { month: month });
    if (requestId !== state.dashboardRequest || month !== state.month) return;
    state.dashboard = data;
    state.today = data.today;
    state.sourceRevision = data.updatedAt;
    rememberTasks(data.overdue);
    rememberTasks(data.longTerm);
    renderTodayLabel();
    renderCalendar();
    renderOverdue(data.overdue);
    renderLongTerm(data.longTerm);
    if (data.warning) toast(data.warning, true);
    else if (showToast) toast("已读取最新工作待办");
    return !data.stale;
  } catch (error) {
    if (requestId !== state.dashboardRequest) return;
    if (!state.dashboard) el.calendarGrid.replaceChildren(createReadError(error.message, () => loadDashboard()));
    toast(error.message, true);
    return false;
  }
}

async function prepareDay(date) {
  const requestId = ++state.dayRequest;
  state.requestedDate = date;
  const current = () => requestId === state.dayRequest && date === state.requestedDate;
  if (date.slice(0, 7) !== state.month) {
    state.month = date.slice(0, 7);
    await loadDashboard();
  } else {
    renderCalendar();
  }
  if (!current()) return;
  const data = await invoke("tasks.day", { id: date });
  if (!current()) return;
  return { current, fresh: !data.stale, commit() {
    state.selectedDate = date;
    state.sourceRevision = data.updatedAt;
    rememberTasks(data.tasks);
    setTaskCount(data.tasks.length);
    renderTaskList(el.dayTasks, data.tasks, "当天没有安排", "◌", dayTaskMeta, true);
  } };
}
  return { loadDashboard, prepareDay };
}
