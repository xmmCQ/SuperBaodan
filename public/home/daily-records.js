const TYPE_LABELS = { meeting: "会议纪要", work: "工作记录", idea: "想法随记", other: "其他" };

export function createDailyRecords({
  state,
  elements: el,
  api,
  dayView,
  editor,
  renderMarkdown,
  toast,
  uiDialogs,
  escapeHtml,
  renderCalendar,
  getSelectedDate,
  getMonth,
  navigateToDate,
  getChatBusy,
  sendChat,
}) {
  let searchTimer = null;

  async function loadDate(date) {
    const requestId = ++state.dayRequest;
    state.selectedDate = date;
    try {
      const data = await api(`/api/daily-records?date=${encodeURIComponent(date)}`, { cache: "no-store" });
      if (requestId !== state.dayRequest || date !== state.selectedDate) return;
      state.records = data.records || [];
      remember(state.records);
      dayView.setRecordCount(state.records.length);
      if (!state.searchQuery) renderList(state.records, false);
    } catch (error) {
      if (requestId !== state.dayRequest) return;
      state.records = [];
      dayView.setRecordCount(0);
      if (!state.searchQuery) el.dailyRecordList.innerHTML = emptyState(error.message, "!");
      toast(error.message, true);
    }
  }

  async function loadMonth(month) {
    const requestId = ++state.monthRequest;
    try {
      const data = await api(`/api/daily-records/summary?month=${encodeURIComponent(month)}`, { cache: "no-store" });
      if (requestId !== state.monthRequest || month !== getMonth()) return;
      state.monthCounts = new Map((data.dates || []).map((item) => [item.date, Number(item.count) || 0]));
      renderCalendar();
    } catch (error) {
      if (requestId !== state.monthRequest) return;
      state.monthCounts = new Map();
      renderCalendar();
      toast(error.message, true);
    }
  }

  function recordCountForDate(date) { return state.monthCounts.get(date) || 0; }

  function renderList(records, searching) {
    state.displayRecords = records;
    if (!records.length) {
      el.dailyRecordList.innerHTML = emptyState(searching ? "没有找到相关记录" : "当天还没有记录", searching ? "⌕" : "✎");
      return;
    }
    el.dailyRecordList.innerHTML = records.map((record) => {
      const expanded = state.expandedIds.has(record.id);
      const preview = plainText(record.content).slice(0, 110);
      return `<article class="daily-record-card ${expanded ? "expanded" : ""}" data-record-id="${record.id}">
        <div class="daily-record-card-head">
          <button class="daily-record-main" data-record-action="toggle" type="button" aria-expanded="${expanded}">
            <span class="daily-record-title-row"><span class="badge record-${record.type}">${TYPE_LABELS[record.type]}</span>${record.time ? `<time>${escapeHtml(record.time)}</time>` : ""}${searching ? `<time>${escapeHtml(record.date)}</time>` : ""}</span>
            <strong>${escapeHtml(record.title)}</strong>
            ${expanded ? "" : `<span class="daily-record-excerpt">${escapeHtml(preview)}${plainText(record.content).length > 110 ? "…" : ""}</span>`}
          </button>
          <div class="daily-record-actions">
            ${searching ? '<button data-record-action="locate" type="button">定位日期</button>' : ""}
            <button data-record-action="send" type="button">交给宝蛋</button>
            <button data-record-action="edit" type="button">编辑</button>
            <button class="danger" data-record-action="delete" type="button">删除</button>
          </div>
        </div>
        ${expanded ? `<article class="daily-record-body markdown-body" data-record-body="${record.id}"></article>` : ""}
      </article>`;
    }).join("");
    for (const record of records) {
      if (!state.expandedIds.has(record.id)) continue;
      renderMarkdown(el.dailyRecordList.querySelector(`[data-record-body="${record.id}"]`), record.content, { onNotice: toast });
    }
  }

  function handleListClick(event) {
    const button = event.target.closest("[data-record-action]");
    const card = event.target.closest("[data-record-id]");
    if (!button || !card || state.saving) return;
    const record = state.recordById.get(card.dataset.recordId);
    if (!record) return void toast("记录已变化，请刷新后重试", true);
    const action = button.dataset.recordAction;
    if (action === "toggle") toggleExpanded(record.id);
    if (action === "edit") editor.open(record, record.date);
    if (action === "delete") void deleteRecord(record);
    if (action === "send") void sendToBaodan(record);
    if (action === "locate") void locateRecord(record);
  }

  function toggleExpanded(id) {
    if (state.expandedIds.has(id)) state.expandedIds.delete(id); else state.expandedIds.add(id);
    renderList(state.displayRecords, Boolean(state.searchQuery));
  }

  function scheduleSearch() {
    clearTimeout(searchTimer);
    const query = el.dailyRecordSearch.value.trim();
    el.clearDailyRecordSearch.classList.toggle("hidden", !query);
    searchTimer = setTimeout(() => void runSearch(query), 250);
  }

  async function runSearch(query = el.dailyRecordSearch.value.trim()) {
    clearTimeout(searchTimer);
    state.searchQuery = query;
    const requestId = ++state.searchRequest;
    if (!query) {
      el.dailyRecordSearch.value = "";
      el.clearDailyRecordSearch.classList.add("hidden");
      el.dailyRecordSearchStatus.classList.add("hidden");
      renderList(state.records, false);
      return;
    }
    el.dailyRecordSearchStatus.textContent = "正在搜索…";
    el.dailyRecordSearchStatus.classList.remove("hidden");
    try {
      const data = await api(`/api/daily-records/search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      if (requestId !== state.searchRequest || query !== state.searchQuery) return;
      remember(data.records || []);
      renderList(data.records || [], true);
      el.dailyRecordSearchStatus.textContent = data.truncated
        ? `共找到 ${data.total} 条，仅展示前50条，请缩小关键词范围`
        : `共找到 ${data.total} 条记录`;
    } catch (error) {
      if (requestId !== state.searchRequest) return;
      el.dailyRecordSearchStatus.textContent = error.message;
      el.dailyRecordList.innerHTML = emptyState(error.message, "!");
    }
  }

  function clearSearch() {
    state.searchQuery = "";
    state.searchRequest += 1;
    el.dailyRecordSearch.value = "";
    el.clearDailyRecordSearch.classList.add("hidden");
    el.dailyRecordSearchStatus.classList.add("hidden");
    renderList(state.records, false);
  }

  async function locateRecord(record) {
    clearSearch();
    await navigateToDate(record.date);
  }

  async function deleteRecord(record) {
    const confirmed = await uiDialogs.confirm(`删除“${record.title}”后无法在页面恢复。`, {
      title: "确定删除每日记录吗？", danger: true, confirmText: "删除记录",
    });
    if (!confirmed) return;
    state.saving = true;
    try {
      await api(`/api/daily-records/${record.id}`, { method: "DELETE", body: JSON.stringify({ revision: record.updatedAt }) });
      state.expandedIds.delete(record.id);
      await refreshViews();
      toast("每日记录已删除");
    } catch (error) {
      await refreshViews();
      toast(error.status === 409 ? "记录已更新，页面已刷新，请重新操作" : error.message, true);
    } finally { state.saving = false; }
  }

  async function sendToBaodan(record) {
    if (getChatBusy()) return void toast("宝蛋正在回复，请稍后再发送记录", true);
    const prompt = `请根据以下原始记录整理成规范的${TYPE_LABELS[record.type]}。请严格依据原文，不补充未提供的事实，并明确列出结论与后续行动。\n\n日期：${record.date}${record.time ? ` ${record.time}` : ""}\n标题：${record.title}\n类型：${TYPE_LABELS[record.type]}\n\n原始记录：\n${record.content}`;
    await sendChat(prompt);
  }

  async function afterSaved() { await refreshViews(); }

  async function refreshViews() {
    await Promise.all([loadDate(getSelectedDate()), loadMonth(getMonth())]);
    if (state.searchQuery) await runSearch(state.searchQuery);
  }

  async function refreshConflict(id) {
    const known = state.recordById.get(id);
    if (!known) return null;
    try {
      const data = await api(`/api/daily-records?date=${encodeURIComponent(known.date)}`, { cache: "no-store" });
      remember(data.records || []);
      const latest = (data.records || []).find((item) => item.id === id) || null;
      if (known.date === getSelectedDate()) {
        state.records = data.records || [];
        dayView.setRecordCount(state.records.length);
        if (!state.searchQuery) renderList(state.records, false);
      }
      return latest;
    } catch { return null; }
  }

  function remember(records) { for (const record of records) state.recordById.set(record.id, record); }
  function emptyState(text, icon) { return `<div class="empty-state"><span>${icon}</span>${escapeHtml(text)}</div>`; }
  function plainText(markdown) { return String(markdown || "").replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`~\[\]()-]/g, " ").replace(/\s+/g, " ").trim(); }

  return {
    loadDate, loadMonth, recordCountForDate, handleListClick, scheduleSearch, runSearch, clearSearch,
    afterSaved, refreshConflict, refreshViews, openNew: () => editor.open(null, getSelectedDate()),
  };
}
