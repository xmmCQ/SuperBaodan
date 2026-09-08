export function createTaskSummary(el) {
  const dialog = el.taskSummaryDialog;
  const entries = {
    overdue: { button: el.openOverdueTasks, count: el.overdueCount, list: el.overdueTasks, title: '遗留工作' },
    longterm: { button: el.openLongtermTasks, count: el.longtermCount, list: el.longtermTasks, title: '持续工作' },
  };
  let current = null, suspended = false, savedScroll = 0;
  function title() {
    if (current) el.taskSummaryTitle.textContent = `${entries[current].title} · ${entries[current].count.textContent} 项`;
  }
  function open(kind, restore = false) {
    current = kind;
    for (const [key, entry] of Object.entries(entries)) entry.list.classList.toggle('hidden', key !== kind);
    el.taskSummaryNotice.classList.add('hidden');
    title();
    dialog.showModal();
    el.taskSummaryBody.scrollTop = restore ? savedScroll : 0;
    el.closeTaskSummary.focus({ preventScroll: true });
  }
  function close() {
    if (!dialog.open) return;
    const trigger = entries[current]?.button;
    dialog.close();
    (trigger && !trigger.classList.contains('hidden') ? trigger : el.todayButton).focus({ preventScroll: true });
  }
  for (const [kind, entry] of Object.entries(entries)) entry.button.addEventListener('click', () => open(kind));
  el.closeTaskSummary.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') event.stopPropagation(); });
  let backdropPress = false;
  const outside = (event) => {
    const r = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom);
  };
  dialog.addEventListener('pointerdown', (event) => { backdropPress = outside(event); });
  dialog.addEventListener('click', (event) => { if (backdropPress && outside(event)) close(); backdropPress = false; });
  return {
    update(kind, count) {
      const entry = entries[kind];
      entry.count.textContent = count;
      entry.button.classList.toggle('hidden', count === 0);
      entry.button.setAttribute('aria-label', `${entry.title}，${count}项，点击查看`);
      el.taskSummaryHints.classList.toggle('hidden', Object.values(entries).every((item) => item.button.classList.contains('hidden')));
      title();
    },
    suspend() {
      if (!dialog.open) return;
      savedScroll = el.taskSummaryBody.scrollTop;
      suspended = true;
      dialog.close();
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      open(current, true);
    },
    notice(message) {
      if (!dialog.open) return;
      el.taskSummaryNotice.textContent = message;
      el.taskSummaryNotice.classList.remove('hidden');
    },
  };
}
