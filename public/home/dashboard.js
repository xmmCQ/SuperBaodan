export function createDashboard({
  state,
  elements: el,
  api,
  rememberTasks,
  renderTodayLabel,
  renderCalendar,
  renderOverdue,
  renderLongTerm,
  toast,
  formatChineseDate,
  loadingState,
  renderTaskList,
  dayTaskMeta,
  emptyState,
  setTaskCount
}) {
async function loadDashboard(showToast = false) {
  const requestId = ++state.dashboardRequest;
  const month = state.month;
  try {
    const data = await api(`/api/dashboard?month=${month}`, { cache: "no-store" });
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
  } catch (error) {
    if (requestId !== state.dashboardRequest) return;
    toast(error.message, true);
  }
}

async function loadDay(date) {
  const requestId = ++state.dayRequest;
  state.selectedDate = date;
  if (date.slice(0, 7) !== state.month) {
    state.month = date.slice(0, 7);
    await loadDashboard();
  } else {
    renderCalendar();
  }
  if (requestId !== state.dayRequest || date !== state.selectedDate) return;
  el.selectedDateTitle.textContent = formatChineseDate(date);
  el.dayTasks.innerHTML = loadingState();
  try {
    const data = await api(`/api/day/${date}`, { cache: "no-store" });
    if (requestId !== state.dayRequest || date !== state.selectedDate) return;
    state.sourceRevision = data.updatedAt;
    rememberTasks(data.tasks);
    setTaskCount(data.tasks.length);
    renderTaskList(el.dayTasks, data.tasks, "当天没有安排", "◌", dayTaskMeta, true);
  } catch (error) {
    if (requestId === state.dayRequest) {
      setTaskCount(0);
      el.dayTasks.innerHTML = emptyState(error.message, "!");
    }
  }
}
  return { loadDashboard, loadDay };
}
