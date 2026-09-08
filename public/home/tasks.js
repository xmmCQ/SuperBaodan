import { createCardOrder, taskOrderKey } from './card-order.js';
import { createTaskSummary } from './task-summary.js';

export function createTasks({
  state,
  elements: el,
  api,
  toast: showToast,
  emptyState,
  escapeHtml,
  formatChineseDate,
  toLocalDate,
  loadDashboard: loadDashboardCallback,
  loadDay: loadDayCallback
}) {
  const summary = createTaskSummary(el);
  const toast = (message, error) => { summary.notice(message); showToast(message, error); };
  const roleLabels = { planned: "计划", due: "截止", completed: "完成", ongoing: "进行中" };
  const recurrenceLabels = { day: "每天", week: "每周", month: "每月", year: "每年" };
  const loadDashboard = (...args) => loadDashboardCallback(...args);
  const loadDay = (...args) => loadDayCallback(...args);
  const order = createCardOrder({ container: el.dayTasks, kind: 'tasks', cardSelector: '.task-card', getDate: () => state.selectedDate, keyForItem: taskOrderKey, busy: () => state.taskSaving, onNotice: toast });
function renderOverdue(tasks) {
  summary.update('overdue', tasks.length);
  renderTaskList(el.overdueTasks, tasks, "暂无遗留工作", "✓", (task) => `
    <span class="badge overdue">逾期 ${task.overdueDays} 天</span>
    <span>${task.anchorDate}</span>
    ${sectionMeta(task)}`);
}

function renderLongTerm(tasks) {
  summary.update('longterm', tasks.length);
  renderTaskList(el.longtermTasks, tasks, "暂无持续工作", "∞", (task) => `
    ${task.recurrence ? `<span class="badge ongoing">${recurrenceLabels[task.recurrence] || task.recurrence}</span>` : ""}
    ${sectionMeta(task)}`);
}

function renderTaskList(container, tasks, emptyText, emptyIcon, metaBuilder, allowDelete = false) {
  if (container === el.dayTasks) tasks = order.prepare(tasks);
  rememberTasks(tasks);
  if (!tasks.length) {
    container.innerHTML = emptyState(emptyText, emptyIcon);
    return;
  }
  container.innerHTML = tasks.map((task) => {
    const moveKind = allowDelete ? taskMoveKind(task, state.selectedDate) : null;
    const moveAttributes = moveKind
      ? `draggable="true" data-move-kind="${moveKind}" data-move-date="${state.selectedDate}" data-tooltip="拖到列表中调整顺序，拖到日历日期可改期"`
      : "";
    return `
      <div class="task-card ${task.checked ? "completed" : ""} ${moveKind ? "task-draggable tooltip-control" : ""}" data-task-id="${task.id}" ${moveAttributes}>
        <button class="task-check tooltip-control tooltip-down" data-action="toggle" type="button" aria-label="${task.checked ? "取消完成" : "标记完成"}" data-tooltip="${task.checked ? "取消完成" : "标记完成"}">${task.checked ? "✓" : ""}</button>
        <div class="task-card-content">
          <div class="task-card-title">${escapeHtml(task.text)}</div>
          <div class="task-meta">${metaBuilder(task)}</div>
        </div>
        <div class="task-card-actions">
          <button class="task-edit" data-action="edit" type="button" aria-label="编辑事项">编辑</button>
          ${(container !== el.overdueTasks && (allowDelete || container === el.longtermTasks)) ? '<button class="task-delete" data-action="delete" type="button" aria-label="删除事项">删除</button>' : ""}
        </div>
      </div>`;
  }).join("");
  if (container === el.dayTasks) order.decorate(tasks);
}

function dayTaskMeta(task) {
  return `
    ${task.roles.map((role) => `<span class="badge ${role}">${roleLabels[role]}</span>`).join("")}
    ${task.conflict ? '<span class="badge conflict">状态冲突</span>' : ""}
    ${task.plannedDate ? `<span>⏳ ${task.plannedDate}</span>` : ""}
    ${task.dueDate ? `<span>📅 ${task.dueDate}</span>` : ""}
    ${task.completedDate ? `<span>✅ ${task.completedDate}</span>` : ""}
    ${task.recurrence ? `<span>🔁 ${recurrenceLabels[task.recurrence] || task.recurrence}</span>` : ""}
    ${sectionMeta(task)}`;
}

function sectionMeta(task) {
  const section = task.headingPath?.at(-1);
  return section ? `<span>${escapeHtml(section)}</span>` : "";
}

function rememberTasks(tasks) {
  for (const task of tasks || []) state.taskById.set(task.id, task);
}

function taskMoveKind(task, sourceDate) {
  if (task.plannedDate === sourceDate && task.dueDate === sourceDate) return "planned-due";
  if (task.plannedDate === sourceDate) return "planned";
  if (task.dueDate === sourceDate) return "due";
  if (task.checked && task.completedDate === sourceDate) return "completed";
  return null;
}

function moveKeepsDateRange(task, sourceDate, targetDate) {
  const kind = taskMoveKind(task, sourceDate);
  const plannedDate = kind === "planned" || kind === "planned-due" ? targetDate : task.plannedDate;
  const dueDate = kind === "due" || kind === "planned-due" ? targetDate : task.dueDate;
  return !(plannedDate && dueDate && plannedDate > dueDate);
}

function handleTaskDragStart(event) {
  const card = event.target.closest(".task-card");
  if (!card || state.taskSaving) {
    event.preventDefault();
    return;
  }
  if (!card.dataset.moveKind) return; // Ongoing cards can reorder without a date to move.
  const task = state.taskById.get(card.dataset.taskId);
  if (!task) {
    event.preventDefault();
    return;
  }
  state.draggedTaskId = task.id;
  state.dragSourceDate = card.dataset.moveDate;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.clearData();
  event.dataTransfer.setData("application/x-superbaodan-task", task.id);
  el.calendarGrid.classList.add("drag-active");
  requestAnimationFrame(() => {
    if (state.draggedTaskId === task.id) card.classList.add("dragging");
  });
}

function handleCalendarDragOver(event) {
  if (!state.draggedTaskId) return;
  const day = event.target.closest(".calendar-day");
  if (!day || !el.calendarGrid.contains(day)) return;
  event.preventDefault();
  clearCalendarDropState();
  const task = state.taskById.get(state.draggedTaskId);
  const sameDate = day.dataset.date === state.dragSourceDate;
  const valid = task && !sameDate && moveKeepsDateRange(task, state.dragSourceDate, day.dataset.date);
  day.classList.add(sameDate ? "drop-origin" : valid ? "drop-target" : "drop-invalid");
  event.dataTransfer.dropEffect = valid ? "move" : "none";
}

function handleCalendarDrop(event) {
  if (!state.draggedTaskId) return;
  const day = event.target.closest(".calendar-day");
  if (!day || !el.calendarGrid.contains(day)) return;
  event.preventDefault();
  const task = state.taskById.get(state.draggedTaskId);
  const sourceDate = state.dragSourceDate;
  const targetDate = day.dataset.date;
  resetTaskDrag();
  if (!task || targetDate === sourceDate) return;
  if (!moveKeepsDateRange(task, sourceDate, targetDate)) {
    toast("计划日不能晚于截止日", true);
    return;
  }
  moveTaskToDate(task, sourceDate, targetDate);
}

function clearCalendarDropState() {
  el.calendarGrid.querySelectorAll(".drop-target, .drop-invalid, .drop-origin")
    .forEach((day) => day.classList.remove("drop-target", "drop-invalid", "drop-origin"));
}

function resetTaskDrag() {
  document.querySelectorAll(".task-card.dragging").forEach((card) => card.classList.remove("dragging"));
  clearCalendarDropState();
  el.calendarGrid.classList.remove("drag-active");
  state.draggedTaskId = null;
  state.dragSourceDate = null;
}

function handleTaskListClick(event) {
  const actionButton = event.target.closest("[data-action]");
  const card = event.target.closest("[data-task-id]");
  if (!actionButton || !card) return;
  const task = state.taskById.get(card.dataset.taskId);
  if (!task) {
    toast("事项已变化，请刷新后重试", true);
    return;
  }
  if (actionButton.dataset.action === "toggle") toggleTaskCompletion(task, actionButton);
  if (actionButton.dataset.action === "edit") openTaskModal(task);
  if (actionButton.dataset.action === "delete") deleteTask(task, actionButton);
}

function openTaskDatePicker(input) {
  state.datePickerField = input.id;
  const anchorDate = input.value || state.selectedDate;
  state.datePickerMonth = anchorDate.slice(0, 7);
  el.taskPlannedDate.setAttribute("aria-expanded", String(input === el.taskPlannedDate));
  el.taskDueDate.setAttribute("aria-expanded", String(input === el.taskDueDate));
  el.taskDatePicker.classList.remove("hidden");
  renderTaskDatePicker();
}

function renderTaskDatePicker() {
  const input = el[state.datePickerField];
  if (!input || !state.datePickerMonth) return;
  const [year, month] = state.datePickerMonth.split("-").map(Number);
  el.datePickerTitle.textContent = `${year}年${month}月`;
  const first = new Date(year, month - 1, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month - 1, 1 - startOffset);
  const anchorDate = input.value || state.selectedDate;
  const days = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const dateString = toLocalDate(date);
    const selected = Boolean(input.value && dateString === input.value);
    const defaultDate = !input.value && dateString === anchorDate;
    days.push(`
      <button class="${date.getMonth() !== month - 1 ? "outside" : ""} ${dateString === state.today ? "today" : ""} ${selected ? "selected" : ""} ${defaultDate ? "default-date" : ""}"
        type="button" data-picker-date="${dateString}" aria-label="${formatChineseDate(dateString)}" aria-pressed="${selected}">
        ${date.getDate()}
      </button>`);
  }
  el.datePickerGrid.innerHTML = days.join("");
}

function changeTaskDatePickerMonth(offset) {
  if (!state.datePickerMonth) return;
  const [year, month] = state.datePickerMonth.split("-").map(Number);
  const next = new Date(year, month - 1 + offset, 1);
  state.datePickerMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  renderTaskDatePicker();
}

function selectTaskDate(event) {
  const button = event.target.closest("[data-picker-date]");
  const input = el[state.datePickerField];
  if (!button || !input) return;
  input.value = button.dataset.pickerDate;
  closeTaskDatePicker();
  input.focus();
}

function clearTaskDate() {
  const input = el[state.datePickerField];
  if (!input) return;
  input.value = "";
  closeTaskDatePicker();
  input.focus();
}

function closeTaskDatePicker() {
  state.datePickerField = null;
  state.datePickerMonth = null;
  el.taskDatePicker.classList.add("hidden");
  el.taskPlannedDate.setAttribute("aria-expanded", "false");
  el.taskDueDate.setAttribute("aria-expanded", "false");
}

function openTaskModal(task = null) {
  summary.suspend();
  state.editingTaskId = task?.id || null;
  el.taskModalTitle.textContent = task ? "编辑工作计划" : "新增工作计划";
  el.taskText.value = task?.editableText || "";
  el.taskPlannedDate.value = task?.plannedDate || "";
  el.taskDueDate.value = task?.dueDate || (task ? "" : state.selectedDate);
  el.taskRecurrence.value = task?.recurrence || "";
  el.taskChecked.checked = Boolean(task?.checked);
  el.taskModal.classList.remove("hidden");
  requestAnimationFrame(() => el.taskText.focus());
}

function closeTaskModal() {
  if (!state.taskSaving) hideTaskModal();
}

function hideTaskModal() {
  state.editingTaskId = null;
  closeTaskDatePicker();
  el.taskModal.classList.add("hidden");
  el.taskForm.reset();
  summary.resume();
}

async function saveTaskForm(event) {
  event.preventDefault();
  if (state.taskSaving) return;
  const editing = Boolean(state.editingTaskId);
  const body = {
    revision: state.sourceRevision,
    text: el.taskText.value.trim(),
    plannedDate: el.taskPlannedDate.value || null,
    dueDate: el.taskDueDate.value || null,
    recurrence: el.taskRecurrence.value || null,
    checked: el.taskChecked.checked,
  };
  if (!body.text) {
    toast("请填写事项内容", true);
    return;
  }
  if (!editing && !body.plannedDate && !body.dueDate && !body.recurrence) {
    toast("请至少设置日期或循环频率", true);
    return;
  }

  state.taskSaving = true;
  el.saveTaskButton.disabled = true;
  el.saveTaskButton.textContent = "正在同步……";
  try {
    const url = editing ? `/api/tasks/${state.editingTaskId}` : "/api/tasks";
    const data = await api(url, {
      method: editing ? "PATCH" : "POST",
      body: JSON.stringify(body),
    });
    state.sourceRevision = data.updatedAt;
    if (editing) { const previous = state.taskById.get(state.editingTaskId); if (previous) order.rename(previous, { ...previous, editableText: body.text }); }
    hideTaskModal();
    await refreshTaskViews();
    toast(editing ? "工作计划已修改并同步" : "工作计划已新增并同步");
  } catch (error) {
    if (error.status === 409) {
      hideTaskModal();
      await refreshTaskViews();
      toast("源文件已更新，页面已刷新，请重新操作", true);
    } else {
      toast(error.message, true);
    }
  } finally {
    state.taskSaving = false;
    el.saveTaskButton.disabled = false;
    el.saveTaskButton.textContent = "保存并同步";
  }
}

async function toggleTaskCompletion(task, button) {
  if (state.taskSaving) return;
  state.taskSaving = true;
  button.disabled = true;
  try {
    const data = await api(`/api/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ revision: state.sourceRevision, checked: !task.checked }),
    });
    state.sourceRevision = data.updatedAt;
    await refreshTaskViews();
    toast(task.checked ? "已取消完成并同步" : "已标记完成并同步");
  } catch (error) {
    if (error.status === 409) await refreshTaskViews();
    toast(error.status === 409 ? "源文件已更新，页面已刷新，请重新操作" : error.message, true);
  } finally {
    state.taskSaving = false;
    button.disabled = false;
  }
}

async function moveTaskToDate(task, sourceDate, targetDate) {
  if (state.taskSaving) return;
  state.taskSaving = true;
  try {
    const data = await api(`/api/tasks/${task.id}/move`, {
      method: "PATCH",
      body: JSON.stringify({ revision: state.sourceRevision, sourceDate, targetDate }),
    });
    state.sourceRevision = data.updatedAt;
    state.selectedDate = targetDate;
    state.month = targetDate.slice(0, 7);
    await loadDashboard();
    await loadDay(targetDate);
    toast(`工作计划已移动到 ${targetDate}`);
  } catch (error) {
    if (error.status === 409) await refreshTaskViews();
    toast(error.status === 409 ? "源文件已更新，页面已刷新，请重新操作" : error.message, true);
  } finally {
    state.taskSaving = false;
  }
}

async function deleteTask(task, button) {
  if (state.taskSaving) return;
  state.taskSaving = true;
  button.disabled = true;
  try {
    const data = await api(`/api/tasks/${task.id}`, {
      method: "DELETE",
      body: JSON.stringify({ revision: state.sourceRevision }),
    });
    state.sourceRevision = data.updatedAt;
    await refreshTaskViews();
    toast("工作计划已删除并同步");
  } catch (error) {
    if (error.status === 409) await refreshTaskViews();
    toast(error.status === 409 ? "源文件已更新，页面已刷新，请重新操作" : error.message, true);
  } finally {
    state.taskSaving = false;
    button.disabled = false;
  }
}

async function refreshTaskViews() {
  await loadDashboard();
  await loadDay(state.selectedDate);
}

async function changeMonth(offset) {
  const [year, month] = state.month.split("-").map(Number);
  const next = new Date(year, month - 1 + offset, 1);
  state.month = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  await loadDashboard();
}
  return { renderOverdue, renderLongTerm, renderTaskList, dayTaskMeta, sectionMeta, rememberTasks, taskMoveKind, moveKeepsDateRange, handleTaskDragStart, handleCalendarDragOver, handleCalendarDrop, clearCalendarDropState, resetTaskDrag, handleTaskListClick, openTaskDatePicker, renderTaskDatePicker, changeTaskDatePickerMonth, selectTaskDate, clearTaskDate, closeTaskDatePicker, openTaskModal, closeTaskModal, hideTaskModal, saveTaskForm, toggleTaskCompletion, moveTaskToDate, deleteTask, refreshTaskViews, changeMonth };
}
