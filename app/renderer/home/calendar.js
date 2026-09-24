import { createHolidayMarks } from './holiday-marks.js';

export function createCalendar({
  invoke,
  state,
  elements: el,
  toLocalDate,
  formatChineseDate,
  loadDay,
  recordCountForDate = () => 0
}) {
const holidays = createHolidayMarks({ container: el.calendarGrid, invoke });
let renderedKey, selected;
const buttons = new Map();
el.calendarGrid.addEventListener('click', event => {
  const button = event.target.closest('.calendar-day');
  if (button && el.calendarGrid.contains(button)) loadDay(button.dataset.date);
});
function selectDay() {
  const next = state.requestedDate || state.selectedDate;
  if (next === selected) return;
  buttons.get(selected)?.classList.remove('selected');
  buttons.get(next)?.classList.add('selected');
  selected = next;
}
function renderCalendar() {
  if (!state.dashboard) return;
  const [year, month] = state.month.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month - 1, 1 - startOffset);
  const dates = Array.from({length:42},(_,i) => { const date = new Date(gridStart); date.setDate(date.getDate()+i); return toLocalDate(date); });
  const key = JSON.stringify([state.month,state.today,state.dashboard.updatedAt || [state.dashboard.events,state.dashboard.pendingByDate],dates.map(recordCountForDate)]);
  if (key === renderedKey) { selectDay(); return; }
  renderedKey = key; selected = null; buttons.clear();
  el.monthTitle.textContent = `${year}年${month}月`;
  const eventsByDate = new Map();

  for (const event of state.dashboard.events) {
    const entries = eventsByDate.get(event.date) || [];
    entries.push(event);
    eventsByDate.set(event.date, entries);
  }

  el.calendarGrid.innerHTML = "";
  for (let i = 0; i < 42; i++) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    const dateString = toLocalDate(date);
    const dayEvents = eventsByDate.get(dateString) || [];
    const isCurrentMonth = date.getMonth() === month - 1;
    const pendingCount = isCurrentMonth ? Number(state.dashboard.pendingByDate?.[dateString] || 0) : 0;
    const recordCount = isCurrentMonth ? Number(recordCountForDate(dateString) || 0) : 0;
    const button = document.createElement("button");
    button.className = [
      "calendar-day",
      !isCurrentMonth ? "outside" : "",
      dateString === state.today ? "today" : "",
      dateString === (state.requestedDate || state.selectedDate) ? "selected" : "",
      pendingCount ? "has-pending" : "",
      recordCount ? "has-records" : "",
    ].filter(Boolean).join(" ");
    button.dataset.date = dateString;
    button.setAttribute("aria-label", `${formatChineseDate(dateString)}${pendingCount ? `，还有${pendingCount}项待办` : ""}${recordCount ? `，有${recordCount}条记录` : ""}`);
    if (pendingCount || recordCount) {
      button.classList.add("tooltip-control", "tooltip-down");
      button.dataset.tooltip = [pendingCount ? `还有 ${pendingCount} 项待办` : "", recordCount ? `${recordCount} 条记录` : ""].filter(Boolean).join(" · ");
    }

    const roles = new Set();
    for (const event of dayEvents) {
      if (event.overdue) roles.add("overdue");
      else event.roles.forEach((role) => roles.add(role));
    }
    button.innerHTML = `
      <span class="day-number">${date.getDate()}</span>
      <span class="day-events">
        ${[...roles].slice(0, 4).map((role) => `<i class="event-dot ${role}"></i>`).join("")}
        ${recordCount ? `<i class="record-calendar-mark" aria-hidden="true"></i>` : ""}
        ${dayEvents.length ? `<span class="event-count">${dayEvents.length}</span>` : ""}
      </span>`;
    buttons.set(dateString,button);
    el.calendarGrid.appendChild(button);
  }
  selectDay(); holidays.refresh();
}
  return { renderCalendar };
}
