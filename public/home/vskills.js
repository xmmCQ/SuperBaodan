export function createVSkills({
  state,
  elements: el,
  api,
  uiDialogs,
  toast,
  escapeHtml,
  getChatBusy,
  sendChat,
  closeChatHistory
}) {
  Object.defineProperty(state, "chatBusy", { get: getChatBusy });
async function loadVSkills() {
  try {
    const data = await api("/api/vskills", { cache: "no-store" });
    state.vskills = data.vskills || [];
    renderVSkillQuickbar();
    renderVSkillList();
  } catch (error) {
    state.vskills = [];
    renderVSkillQuickbar();
    if (!el.vskillDrawer.classList.contains("hidden")) el.vskillList.innerHTML = `<div class="history-empty">${escapeHtml(error.message)}</div>`;
    else console.warn(error);
  }
}

function renderVSkillQuickbar() {
  el.vskillQuickbar.replaceChildren();
  el.vskillQuickbar.classList.toggle("hidden", !state.vskills.length);
  for (const vskill of state.vskills) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vskill-chip";
    button.dataset.vskillId = vskill.id;
    button.textContent = vskill.name;
    button.disabled = state.chatBusy;
    el.vskillQuickbar.append(button);
  }
}

function renderVSkillList() {
  if (!el.vskillForm.classList.contains("hidden")) return;
  el.vskillList.replaceChildren();
  if (!state.vskills.length) {
    el.vskillList.innerHTML = '<div class="history-empty">暂无VSkill，点击“新建”开始配置。</div>';
    return;
  }
  for (const vskill of state.vskills) {
    const card = document.createElement("article");
    card.className = "vskill-item";
    card.dataset.vskillId = vskill.id;
    const content = document.createElement("div");
    content.className = "vskill-item-content";
    const name = document.createElement("strong");
    name.textContent = vskill.name;
    const prompt = document.createElement("p");
    prompt.textContent = vskill.prompt;
    content.append(name, prompt);
    const actions = document.createElement("div");
    actions.className = "vskill-item-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.dataset.vskillAction = "edit";
    edit.textContent = "编辑";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.vskillAction = "delete";
    remove.className = "delete";
    remove.textContent = "删除";
    edit.disabled = remove.disabled = state.vskillBusy;
    actions.append(edit, remove);
    card.append(content, actions);
    el.vskillList.append(card);
  }
}

async function openVSkillDrawer() {
  if (state.chatBusy) return;
  closeChatHistory();
  closeVSkillForm();
  el.vskillDrawer.classList.remove("hidden");
  await loadVSkills();
}

function closeVSkillDrawer() {
  closeVSkillForm();
  el.vskillDrawer.classList.add("hidden");
}

function openVSkillForm(vskill = null) {
  if (state.vskillBusy) return;
  state.vskillEditingId = vskill?.id || null;
  el.vskillFormTitle.textContent = vskill ? "编辑VSkill" : "新建VSkill";
  el.vskillName.value = vskill?.name || "";
  el.vskillPrompt.value = vskill?.prompt || "";
  el.vskillList.classList.add("hidden");
  el.vskillForm.classList.remove("hidden");
  el.vskillName.focus();
}

function closeVSkillForm() {
  state.vskillEditingId = null;
  el.vskillForm.reset();
  el.vskillForm.classList.add("hidden");
  el.vskillList.classList.remove("hidden");
  renderVSkillList();
}

function handleVSkillQuickClick(event) {
  const button = event.target.closest("[data-vskill-id]");
  if (!button || state.chatBusy) return;
  const vskill = state.vskills.find((item) => item.id === button.dataset.vskillId);
  if (vskill) void sendChat(vskill.prompt);
}

function handleVSkillListClick(event) {
  const action = event.target.closest("[data-vskill-action]")?.dataset.vskillAction;
  const card = event.target.closest("[data-vskill-id]");
  if (!action || !card || state.vskillBusy) return;
  const vskill = state.vskills.find((item) => item.id === card.dataset.vskillId);
  if (!vskill) return;
  if (action === "edit") openVSkillForm(vskill);
  if (action === "delete") void deleteVSkill(vskill);
}

async function saveVSkill(event) {
  event.preventDefault();
  if (state.vskillBusy) return;
  const payload = { name: el.vskillName.value, prompt: el.vskillPrompt.value };
  const editingId = state.vskillEditingId;
  setVSkillBusy(true);
  try {
    const url = editingId ? `/api/vskills/${encodeURIComponent(editingId)}` : "/api/vskills";
    await api(url, {
      method: editingId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    closeVSkillForm();
    await loadVSkills();
    toast(editingId ? "VSkill已更新" : "VSkill已创建");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setVSkillBusy(false);
  }
}

async function deleteVSkill(vskill) {
  if (!await uiDialogs.confirm(`确定删除VSkill“${vskill.name}”吗？`, { title: "删除VSkill", danger: true, confirmText: "删除" })) return;
  setVSkillBusy(true);
  try {
    await api(`/api/vskills/${encodeURIComponent(vskill.id)}`, {
      method: "DELETE",
      body: "{}",
    });
    await loadVSkills();
    toast("VSkill已删除");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setVSkillBusy(false);
  }
}

function setVSkillBusy(busy) {
  state.vskillBusy = busy;
  el.newVSkillButton.disabled = busy;
  el.saveVSkillButton.disabled = busy;
  el.vskillName.disabled = busy;
  el.vskillPrompt.disabled = busy;
  for (const button of el.vskillList.querySelectorAll("button")) button.disabled = busy;
}
  return { loadVSkills, renderVSkillQuickbar, renderVSkillList, openVSkillDrawer, closeVSkillDrawer, openVSkillForm, closeVSkillForm, handleVSkillQuickClick, handleVSkillListClick, saveVSkill, deleteVSkill, setVSkillBusy };
}
