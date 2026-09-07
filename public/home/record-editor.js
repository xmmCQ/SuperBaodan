const MEETING_TEMPLATE = `## 参会人员

- 

## 讨论要点

- 

## 会议结论

- 

## 后续行动

- [ ] `;

export function createRecordEditor({ state, elements: el, api, uiDialogs, renderMarkdown, toast, onSaved, onConflict }) {
  let previewFrame = null;

  function open(record, date) {
    state.editingRecord = record || null;
    state.editorSaving = false;
    el.dailyRecordModalTitle.textContent = record ? "编辑记录" : "新增记录";
    el.dailyRecordDateLabel.textContent = `${date} · 每日记录`;
    el.dailyRecordTitle.value = record?.title || "";
    el.dailyRecordType.value = record?.type || "work";
    el.dailyRecordTime.value = record?.time || "";
    el.dailyRecordContent.value = record?.content || "";
    state.editorInitial = snapshot();
    updatePreview();
    el.dailyRecordModal.classList.remove("hidden");
    requestAnimationFrame(() => el.dailyRecordTitle.focus());
  }

  async function requestClose() {
    if (el.dailyRecordModal.classList.contains("hidden") || state.editorSaving) return;
    if (snapshot() !== state.editorInitial) {
      const confirmed = await uiDialogs.confirm("当前记录尚未保存，关闭后修改会丢失。", {
        title: "放弃本次修改吗？", danger: true, confirmText: "放弃修改",
      });
      if (!confirmed) return;
    }
    hide();
  }

  function hide() {
    if (previewFrame != null) cancelAnimationFrame(previewFrame);
    previewFrame = null;
    el.dailyRecordModal.classList.add("hidden");
    state.editingRecord = null;
    state.editorInitial = "";
  }

  function handleTypeChange() {
    if (el.dailyRecordType.value !== "meeting" || el.dailyRecordContent.value.trim()) return;
    el.dailyRecordContent.value = MEETING_TEMPLATE;
    updatePreview();
    el.dailyRecordContent.focus();
    el.dailyRecordContent.setSelectionRange(el.dailyRecordContent.value.length, el.dailyRecordContent.value.length);
  }

  function queuePreview() {
    if (previewFrame != null) cancelAnimationFrame(previewFrame);
    previewFrame = requestAnimationFrame(updatePreview);
  }

  function updatePreview() {
    previewFrame = null;
    const content = el.dailyRecordContent.value;
    if (!content.trim()) {
      el.dailyRecordPreview.innerHTML = '<p class="daily-record-preview-empty">正文预览将显示在这里</p>';
      return;
    }
    renderMarkdown(el.dailyRecordPreview, content, { onNotice: toast });
  }

  async function submit(event) {
    event.preventDefault();
    if (state.editorSaving) return;
    const title = el.dailyRecordTitle.value.trim();
    const content = el.dailyRecordContent.value;
    if (!title) return void toast("请输入记录标题", true);
    if (!content.trim()) return void toast("请输入记录正文", true);
    state.editorSaving = true;
    el.saveDailyRecordButton.disabled = true;
    el.saveDailyRecordButton.textContent = "正在保存…";
    const current = state.editingRecord;
    const body = {
      title,
      type: el.dailyRecordType.value,
      time: el.dailyRecordTime.value,
      content,
      ...(current ? { revision: current.updatedAt } : { date: state.selectedDate }),
    };
    try {
      const data = await api(current ? `/api/daily-records/${current.id}` : "/api/daily-records", {
        method: current ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      hide();
      await onSaved(data.record, Boolean(current));
      toast(current ? "每日记录已更新" : "每日记录已保存");
    } catch (error) {
      if (error.status === 409) {
        const latest = await onConflict(current?.id);
        if (latest) state.editingRecord = latest;
      }
      toast(error.status === 409 ? "记录已更新，当前草稿已保留，请核对后重新保存" : error.message, true);
    } finally {
      state.editorSaving = false;
      el.saveDailyRecordButton.disabled = false;
      el.saveDailyRecordButton.textContent = "保存记录";
    }
  }

  function snapshot() {
    return JSON.stringify({
      title: el.dailyRecordTitle.value,
      type: el.dailyRecordType.value,
      time: el.dailyRecordTime.value,
      content: el.dailyRecordContent.value,
    });
  }

  return { open, requestClose, submit, handleTypeChange, queuePreview, isOpen: () => !el.dailyRecordModal.classList.contains("hidden") };
}
