export function createDayView({ state, elements: el }) {
  function setActive(tab) {
    state.activeTab = tab === "records" ? "records" : "tasks";
    const recordsActive = state.activeTab === "records";
    el.dayTasksTab.classList.toggle("active", !recordsActive);
    el.dailyRecordsTab.classList.toggle("active", recordsActive);
    el.dayTasksTab.setAttribute("aria-selected", String(!recordsActive));
    el.dailyRecordsTab.setAttribute("aria-selected", String(recordsActive));
    el.dayTasksPane.classList.toggle("hidden", recordsActive);
    el.dailyRecordsPane.classList.toggle("hidden", !recordsActive);
    el.newTaskButton.classList.toggle("hidden", recordsActive);
    el.newDailyRecordButton.classList.toggle("hidden", !recordsActive);
    updateCount();
  }

  function setTaskCount(count) {
    state.taskCount = Number(count) || 0;
    el.dayTasksTabCount.textContent = state.taskCount;
    updateCount();
  }

  function setRecordCount(count) {
    state.recordCount = Number(count) || 0;
    el.dailyRecordsTabCount.textContent = state.recordCount;
    updateCount();
  }

  function updateCount() {
    const count = state.activeTab === "records" ? state.recordCount : state.taskCount;
    el.dayCount.textContent = `${count} 项`;
  }

  setActive(state.activeTab);
  return { setActive, setTaskCount, setRecordCount, active: () => state.activeTab };
}
