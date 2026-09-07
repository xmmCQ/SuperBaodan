export function createSkillsController({
  state,
  elements: el,
  api,
  uiDialogs,
  renderMarkdown,
  markdownBodyWithoutFrontmatter,
  showNotice,
  showError,
  showSettingsToast
}) {
async function loadSkills({ preserveSelection = false } = {}) {
  const previous = preserveSelection ? state.selectedSkillId : null;
  el.skillsList.innerHTML = '<div class="muted">正在读取……</div>';
  try {
    const data = await api("/api/skills");
    state.skills = data.skills || [];
    state.skillDiagnostics = data.diagnostics || [];
    state.skillCliAvailable = Boolean(data.cliAvailable);
    state.selectedSkillId = state.skills.some((skill) => skill.id === previous) ? previous : state.skills[0]?.id || null;
    state.skillAdding = false;
    renderSkills();
  } catch (error) {
    el.skillsList.textContent = `读取失败：${error.message}`;
    showSettingsToast(error.message, "error");
  }
}

function renderSkills() {
  el.skillCliStatus.textContent = state.skillCliAvailable ? "skills CLI可用" : "未检测到npx，仅可管理本地Skill";
  el.skillCliStatus.className = state.skillCliAvailable ? "skill-cli-ok" : "muted";
  el.checkAllSkillUpdates.disabled = !state.skillCliAvailable || state.skillBusy;
  renderSkillsList();
  renderSkillDetail();
  renderSkillDiagnostics();
}

function renderSkillsList() {
  if (!state.skills) return;
  const query = el.skillsFilter.value.trim().toLowerCase();
  const filtered = state.skills.filter((skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query));
  el.skillsList.replaceChildren();
  const groups = [
    ["project", "项目 Skill"],
    ["global", "全局 Skill"],
    ["other", "其他来源（只读）"],
  ];
  for (const [scope, label] of groups) {
    const members = filtered.filter((skill) => skill.scope === scope);
    if (!members.length) continue;
    const title = document.createElement("div"); title.className = "skill-group-title"; title.textContent = `${label} · ${members.length}`; el.skillsList.append(title);
    for (const skill of members) {
      const row = document.createElement("button"); row.className = `skill-list-item${skill.id === state.selectedSkillId && !state.skillAdding ? " active" : ""}`;
      const line = document.createElement("span"); line.className = "skill-list-name"; line.textContent = skill.name;
      const status = document.createElement("i");
      const update = skill.install ? state.skillUpdates[skillUpdateKey(skill.install)] : null;
      status.textContent = update?.state === "update-available" ? "↑" : skill.disableModelInvocation ? "○" : "●";
      status.className = update?.state === "update-available" ? "skill-update-dot" : skill.disableModelInvocation ? "skill-off-dot" : "skill-on-dot";
      const desc = document.createElement("small"); desc.textContent = skill.description || "无描述";
      row.append(line, status, desc);
      row.addEventListener("click", () => { state.selectedSkillId = skill.id; state.skillAdding = false; state.skillEditorRaw = false; renderSkills(); });
      el.skillsList.append(row);
    }
  }
  if (!filtered.length) { const empty = document.createElement("div"); empty.className = "muted skill-empty"; empty.textContent = query ? "没有匹配的 Skill" : "暂无 Skill"; el.skillsList.append(empty); }
}

function renderSkillDetail() {
  if (state.skillAdding) return renderSkillAddPanel();
  const skill = state.skills?.find((item) => item.id === state.selectedSkillId);
  el.skillsDetail.replaceChildren();
  if (!skill) { const empty = document.createElement("div"); empty.className = "muted"; empty.textContent = "选择一个 Skill 查看详情"; el.skillsDetail.append(empty); return; }

  const heading = document.createElement("div"); heading.className = "skill-detail-heading";
  const titleWrap = document.createElement("div");
  const title = document.createElement("h3"); title.textContent = skill.name;
  const badges = document.createElement("div"); badges.className = "skill-badges";
  badges.append(skillBadge(skill.scope === "project" ? "项目" : skill.scope === "global" ? "全局" : "只读"));
  if (skill.install) badges.append(skillBadge("skills.sh", "managed"));
  else if (skill.writable) badges.append(skillBadge("自定义", "custom"));
  titleWrap.append(title, badges);
  heading.append(titleWrap);
  if (skill.scope !== "other") {
    const toggle = document.createElement("label"); toggle.className = "skill-invocation-toggle";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = !skill.disableModelInvocation; checkbox.disabled = state.skillBusy;
    checkbox.addEventListener("change", () => toggleSkillInvocation(skill, checkbox));
    const text = document.createElement("span"); text.textContent = "允许调用";
    toggle.append(checkbox, text); heading.append(toggle);
  }
  el.skillsDetail.append(heading);
  appendSkillField("描述", skill.description || "无", el.skillsDetail);
  appendSkillField("路径", skill.filePath, el.skillsDetail, "code");
  appendSkillField("来源", skill.source || skill.scope, el.skillsDetail);
  if (skill.install) {
    appendSkillField("版本", shortSkillVersion(skill.install.versionHash), el.skillsDetail, "code");
    if (skill.install.skillsShUrl) {
      const field = createSkillField("源页面"); const link = document.createElement("a"); link.href = skill.install.skillsShUrl; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = "在 skills.sh 查看 ↗"; field.append(link); el.skillsDetail.append(field);
    }
    renderManagedSkillActions(skill);
  } else if (skill.writable) renderCustomSkillEditor(skill);
  else {
    const note = document.createElement("p"); note.className = "settings-scope-note"; note.textContent = "该 Skill 来自插件、附加路径或只读位置，只能查看。"; el.skillsDetail.append(note);
  }
  if (skill.auxiliaryFiles?.length) {
    const field = createSkillField(`附属文件（${skill.auxiliaryFiles.length}）`);
    const list = document.createElement("ul"); list.className = "skill-file-list";
    for (const file of skill.auxiliaryFiles) { const item = document.createElement("li"); item.textContent = file; list.append(item); }
    field.append(list); el.skillsDetail.append(field);
  }
  const invocationNote = document.createElement("p"); invocationNote.className = "muted skill-invocation-note"; invocationNote.textContent = "关闭自动调用后，模型提示词中将隐藏此 Skill，但仍可手动调用。"; el.skillsDetail.append(invocationNote);
}

function renderManagedSkillActions(skill) {
  const update = state.skillUpdates[skillUpdateKey(skill.install)];
  const box = document.createElement("div"); box.className = "skill-managed-actions";
  const check = skillButton(update?.state === "checking" ? "检查中……" : "检查更新", () => checkSkillUpdates(skill), "");
  check.disabled = state.skillBusy || !state.skillCliAvailable || !skill.install.canCheckForUpdates;
  box.append(check);
  if (update?.state === "update-available") box.append(skillButton("更新", () => updateSkill(skill), "primary"));
  const uninstall = skillButton("卸载", () => uninstallSkill(skill), "danger-lite"); uninstall.disabled = state.skillBusy || !state.skillCliAvailable; box.append(uninstall);
  const status = document.createElement("span"); status.className = `skill-update-status ${update?.state || ""}`;
  status.textContent = update ? skillUpdateLabel(update) : skill.install.canCheckForUpdates ? "尚未检查更新" : "暂不支持自动检查";
  box.append(status); el.skillsDetail.append(box);
}

function renderCustomSkillEditor(skill) {
  const tabs = document.createElement("div"); tabs.className = "skill-editor-tabs";
  const structured = skillButton("结构化编辑", () => { state.skillEditorRaw = false; renderSkillDetail(); });
  const raw = skillButton("原始 Markdown", () => { state.skillEditorRaw = true; renderSkillDetail(); });
  structured.classList.toggle("active", !state.skillEditorRaw); raw.classList.toggle("active", state.skillEditorRaw); tabs.append(structured, raw); el.skillsDetail.append(tabs);
  const form = document.createElement("div"); form.className = "skill-editor";
  if (state.skillEditorRaw) {
    form.append(createExpandableSkillField({ label: "SKILL.md", editorTitle: "编辑完整 SKILL.md", id: "skillRawContent", value: skill.content || "", className: "skill-raw-editor", monospace: true, spellcheck: false, saveLabel: "保存 Skill", markdownPreview: true, stripFrontmatter: true }));
  } else {
    const name = document.createElement("label"); name.textContent = "名称（创建后不可修改）"; const input = document.createElement("input"); input.value = skill.name; input.disabled = true; name.append(input);
    const description = createExpandableSkillField({ label: "描述", editorTitle: "编辑描述", id: "skillEditDescription", value: skill.description || "", rows: 3, saveLabel: "保存 Skill" });
    const body = createExpandableSkillField({ label: "指令正文", editorTitle: "编辑指令正文", id: "skillEditBody", value: skill.body || "", className: "skill-body-editor", monospace: true, spellcheck: false, saveLabel: "保存 Skill", markdownPreview: true });
    form.append(name, description, body);
  }
  const actions = document.createElement("div"); actions.className = "skill-form-actions";
  const save = skillButton("保存 Skill", () => saveCustomSkill(skill), "primary"); save.disabled = state.skillBusy;
  const remove = skillButton("删除", () => deleteCustomSkill(skill), "danger-lite"); remove.disabled = state.skillBusy;
  actions.append(remove, save); form.append(actions); el.skillsDetail.append(form);
}

function renderSkillAddPanel() {
  el.skillsDetail.replaceChildren();
  const head = document.createElement("div"); head.className = "skill-detail-heading";
  const title = document.createElement("h3"); title.textContent = "添加 Skill";
  const close = skillButton("取消", () => { state.skillAdding = false; renderSkills(); }); head.append(title, close); el.skillsDetail.append(head);
  const tabs = document.createElement("div"); tabs.className = "skill-editor-tabs";
  const market = skillButton("从 skills.sh 安装", () => { state.skillAddMode = "market"; renderSkillAddPanel(); });
  const custom = skillButton("创建自定义 Skill", () => { state.skillAddMode = "custom"; renderSkillAddPanel(); });
  market.classList.toggle("active", state.skillAddMode === "market"); custom.classList.toggle("active", state.skillAddMode === "custom"); tabs.append(market, custom); el.skillsDetail.append(tabs);
  if (state.skillAddMode === "market") renderSkillMarketPanel(); else renderNewCustomSkillPanel();
}

function renderSkillMarketPanel() {
  const panel = document.createElement("div"); panel.className = "skill-add-panel";
  const note = document.createElement("p"); note.className = "settings-scope-note"; note.textContent = "Skill来自第三方GitHub仓库。安装会联网运行官方 skills CLI，并产生匿名安装统计；请先审查来源。";
  const searchRow = document.createElement("div"); searchRow.className = "skill-market-search";
  const input = document.createElement("input"); input.id = "skillMarketQuery"; input.type = "search"; input.value = state.skillMarketQuery;
  input.addEventListener("input", () => { state.skillMarketQuery = input.value; });
  const button = skillButton("搜索", () => searchSkillMarket(input.value), "primary");
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); searchSkillMarket(input.value); } });
  searchRow.append(input, button); panel.append(note, searchRow);
  const results = document.createElement("div"); results.className = "skill-market-results";
  if (state.skillBusy) {
    const loading = document.createElement("div"); loading.className = "muted skill-empty"; loading.textContent = "努力搜索ing"; results.append(loading);
  } else {
    if (!state.skillCliAvailable) { const warning = document.createElement("div"); warning.className = "skill-warning"; warning.textContent = "未找到 npx.cmd：可搜索浏览，但暂不能安装。"; results.append(warning); }
    for (const item of state.skillSearchResults) results.append(renderSkillSearchResult(item));
    if (state.skillMarketQuery && !state.skillSearchResults.length) { const empty = document.createElement("div"); empty.className = "muted skill-empty"; empty.textContent = "没有找到匹配的 Skill"; results.append(empty); }
  }
  panel.append(results); el.skillsDetail.append(panel); setTimeout(() => input.focus(), 0);
}

function renderSkillSearchResult(item) {
  const card = document.createElement("article"); card.className = "skill-market-card";
  const info = document.createElement("div"); const name = document.createElement("b"); name.textContent = item.name; const source = document.createElement("small"); source.textContent = `${item.source} · ${formatSkillInstalls(item.installs)}`; const desc = document.createElement("p"); desc.textContent = item.description || "暂无描述"; info.append(name, source, desc);
  const actions = document.createElement("div"); actions.className = "skill-market-actions";
  const link = document.createElement("a"); link.href = item.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = "查看来源";
  const scope = document.createElement("select"); scope.append(new Option("当前项目", "project"), new Option("全局", "global"));
  const install = skillButton("安装", () => installSkill(item, scope.value), "primary"); install.disabled = !state.skillCliAvailable || state.skillBusy;
  actions.append(link, scope, install); card.append(info, actions); return card;
}

function renderNewCustomSkillPanel() {
  const panel = document.createElement("div"); panel.className = "skill-add-panel skill-editor";
  const scopeLabel = document.createElement("label"); scopeLabel.textContent = "保存范围"; const scope = document.createElement("select"); scope.id = "newSkillScope"; scope.append(new Option("当前项目", "project"), new Option("全局", "global")); scopeLabel.append(scope);
  const nameLabel = document.createElement("label"); nameLabel.textContent = "名称"; const name = document.createElement("input"); name.id = "newSkillName"; name.placeholder = "my-skill"; nameLabel.append(name);
  const tabs = document.createElement("div"); tabs.className = "skill-editor-tabs compact";
  const structured = skillButton("结构化", () => { state.skillCreateRaw = false; renderSkillAddPanel(); }); const raw = skillButton("原始 Markdown", () => { state.skillCreateRaw = true; renderSkillAddPanel(); }); structured.classList.toggle("active", !state.skillCreateRaw); raw.classList.toggle("active", state.skillCreateRaw); tabs.append(structured, raw);
  panel.append(scopeLabel, nameLabel, tabs);
  if (state.skillCreateRaw) {
    panel.append(createExpandableSkillField({ label: "完整 SKILL.md", editorTitle: "编辑完整 SKILL.md", id: "newSkillRaw", value: '---\nname: "my-skill"\ndescription: "说明这个Skill何时使用"\n---\n\n# 指令\n', className: "skill-raw-editor", monospace: true, spellcheck: false, saveLabel: "创建 Skill", markdownPreview: true, stripFrontmatter: true }));
  } else {
    const description = createExpandableSkillField({ label: "描述", editorTitle: "编辑描述", id: "newSkillDescription", rows: 3, placeholder: "清楚说明这个Skill适用的任务", saveLabel: "创建 Skill" });
    const body = createExpandableSkillField({ label: "指令正文", editorTitle: "编辑指令正文", id: "newSkillBody", className: "skill-body-editor", monospace: true, spellcheck: false, placeholder: "# 工作流程\n\n写下执行规则……", saveLabel: "创建 Skill", markdownPreview: true });
    panel.append(description, body);
  }
  const save = skillButton("创建 Skill", createCustomSkill, "primary"); save.disabled = state.skillBusy; const actions = document.createElement("div"); actions.className = "skill-form-actions"; actions.append(save); panel.append(actions); el.skillsDetail.append(panel); setTimeout(() => name.focus(), 0);
}

async function searchSkillMarket(query) {
  state.skillMarketQuery = query.trim();
  if (!state.skillMarketQuery) { state.skillSearchResults = []; return renderSkillAddPanel(); }
  try {
    state.skillBusy = true; renderSkillAddPanel();
    const data = await api(`/api/skills/search?q=${encodeURIComponent(state.skillMarketQuery)}`);
    state.skillSearchResults = data.results || [];
    renderSkillAddPanel();
  } catch (error) { showSettingsToast(error.message, "error"); }
  finally { state.skillBusy = false; renderSkillAddPanel(); }
}

async function installSkill(item, scope) {
  const place = scope === "global" ? "全局" : "当前项目";
  const message = `确认安装 ${item.name}？\n\n来源：${item.source}\n范围：${place}\n操作：联网运行 npx skills add\n\n第三方Skill可能包含脚本或危险指令，skills CLI会产生匿名安装统计。请确认你已审查来源。`;
  if (!await uiDialogs.confirm(message, { title: "安装 Skill", danger: true, confirmText: "确认安装" })) return;
  await runSkillMutation(() => api("/api/skills/install", { method: "POST", body: JSON.stringify({ package: item.package, scope }) }), "安装成功");
}

async function updateSkill(skill) {
  if (!await uiDialogs.confirm(`来源：${skill.install.source}\n范围：${scopeLabel(skill.scope)}\n更新会覆盖该安装项的现有文件。`, { title: `确认更新 ${skill.name}？`, danger: true, confirmText: "确认更新" })) return;
  await runSkillMutation(() => api("/api/skills/update", { method: "POST", body: JSON.stringify({ package: skill.install.package, scope: skill.scope }) }), "更新成功");
}

async function uninstallSkill(skill) {
  if (!await uiDialogs.confirm(`来源：${skill.install.source}\n范围：${scopeLabel(skill.scope)}\n卸载前会自动备份。`, { title: `确认卸载 ${skill.name}？`, danger: true, confirmText: "确认卸载" })) return;
  await runSkillMutation(() => api("/api/skills/uninstall", { method: "POST", body: JSON.stringify({ name: skill.name, package: skill.install.package, scope: skill.scope }) }), "卸载成功");
}

async function toggleSkillInvocation(skill, checkbox) {
  checkbox.disabled = true;
  try {
    const result = await api("/api/skills/invocation", { method: "PATCH", body: JSON.stringify({ name: skill.name, scope: skill.scope, disableModelInvocation: !checkbox.checked }) });
    showSettingsToast(result.unchanged ? "未修改" : "保存成功", result.unchanged ? "unchanged" : "success");
    await loadSkills({ preserveSelection: true });
  } catch (error) { checkbox.checked = !checkbox.checked; showSettingsToast(error.message, "error"); }
  finally { checkbox.disabled = false; }
}

async function saveCustomSkill(skill) {
  const payload = { name: skill.name, scope: skill.scope, mode: state.skillEditorRaw ? "raw" : "structured" };
  if (state.skillEditorRaw) payload.content = el.skillsDetail.querySelector("#skillRawContent").value;
  else { payload.description = el.skillsDetail.querySelector("#skillEditDescription").value; payload.body = el.skillsDetail.querySelector("#skillEditBody").value; }
  await runSkillMutation(async () => {
    const result = await api("/api/skills/custom", { method: "PUT", body: JSON.stringify(payload) });
    if (result.unchanged) return { unchanged: true };
    return result;
  }, "保存成功", skill.id);
}

async function createCustomSkill() {
  const name = el.skillsDetail.querySelector("#newSkillName").value.trim();
  const scope = el.skillsDetail.querySelector("#newSkillScope").value;
  const payload = { name, scope, mode: state.skillCreateRaw ? "raw" : "structured" };
  if (state.skillCreateRaw) payload.content = el.skillsDetail.querySelector("#newSkillRaw").value;
  else { payload.description = el.skillsDetail.querySelector("#newSkillDescription").value; payload.body = el.skillsDetail.querySelector("#newSkillBody").value; }
  await runSkillMutation(() => api("/api/skills/custom", { method: "POST", body: JSON.stringify(payload) }), "创建成功");
}

async function deleteCustomSkill(skill) {
  if (!await uiDialogs.confirm("将删除整个 Skill 目录，删除前会自动备份。", { title: `确认删除自定义 Skill「${skill.name}」？`, danger: true, confirmText: "确认删除" })) return;
  await runSkillMutation(() => api("/api/skills/custom", { method: "DELETE", body: JSON.stringify({ name: skill.name, scope: skill.scope }) }), "删除成功");
}

async function checkSkillUpdates(skill = null) {
  if (state.skillBusy) return;
  state.skillBusy = true;
  if (skill?.install) state.skillUpdates[skillUpdateKey(skill.install)] = { state: "checking" };
  renderSkills();
  try {
    const body = skill?.install ? { package: skill.install.package, scope: skill.scope } : {};
    const data = await api("/api/skills/check-updates", { method: "POST", body: JSON.stringify(body) });
    for (const update of data.updates || []) state.skillUpdates[skillUpdateKey(update)] = update;
    const count = (data.updates || []).filter((item) => item.state === "update-available").length;
    showSettingsToast(count ? `发现 ${count} 个更新` : "已是最新", count ? "success" : "unchanged");
  } catch (error) { showSettingsToast(error.message, "error"); }
  finally { state.skillBusy = false; renderSkills(); }
}

async function runSkillMutation(operation, successMessage, preserveId = null) {
  if (state.skillBusy) return;
  state.skillBusy = true; renderSkills();
  try {
    const result = await operation();
    showSettingsToast(result?.unchanged ? "未修改" : successMessage, result?.unchanged ? "unchanged" : "success");
    state.selectedSkillId = preserveId;
    await loadSkills({ preserveSelection: Boolean(preserveId) });
  } catch (error) { showSettingsToast(error.message, "error"); showError(error); }
  finally { state.skillBusy = false; if (state.skills) renderSkills(); }
}

function renderSkillDiagnostics() {
  el.skillDiagnostics.replaceChildren();
  el.skillDiagnosticsBox.classList.toggle("hidden", !state.skillDiagnostics.length);
  for (const diagnostic of state.skillDiagnostics) {
    const row = document.createElement("div"); row.className = "skill-diagnostic-row";
    const message = document.createElement("b"); message.textContent = diagnostic.message || "Skill加载诊断";
    const file = document.createElement("small"); file.textContent = diagnostic.path || "";
    row.append(message, file); el.skillDiagnostics.append(row);
  }
}

function createExpandableSkillField({ label, editorTitle, id, value = "", rows = 0, className = "", monospace = false, spellcheck = true, placeholder = "", saveLabel = "保存 Skill", markdownPreview = false, stripFrontmatter = false }) {
  const field = document.createElement("label");
  field.className = "skill-expandable-field";
  const heading = document.createElement("span"); heading.className = "skill-editor-label-row";
  const title = document.createElement("span"); title.textContent = label;
  const textarea = document.createElement("textarea"); textarea.id = id; textarea.value = value; textarea.spellcheck = spellcheck;
  if (rows) textarea.rows = rows;
  if (className) textarea.className = className;
  if (placeholder) textarea.placeholder = placeholder;
  const expand = skillButton("", async (event) => {
    event.preventDefault();
    const result = await uiDialogs.editor(editorTitle, textarea.value, {
      large: true,
      monospace,
      rows: 24,
      ariaLabel: editorTitle,
      message: `点击“应用”后，仍需点击“${saveLabel}”才会正式保存。`,
      confirmText: "应用",
      previewRenderer: markdownPreview
        ? (container, markdown) => renderMarkdown(container, stripFrontmatter ? markdownBodyWithoutFrontmatter(markdown) : markdown, { onNotice: showNotice })
        : null,
    });
    if (result == null) return;
    textarea.value = result;
    textarea.focus();
  }, "skill-expand-editor icon-action tooltip-left");
  expand.setAttribute("aria-label", "展开编辑");
  expand.dataset.tooltip = "展开编辑";
  expand.innerHTML = '<svg aria-hidden="true"><use href="/icons.svg#maximize-2"></use></svg>';
  expand.disabled = state.skillBusy;
  heading.append(title, expand);
  field.append(heading, textarea);
  return field;
}

function createSkillField(label) { const field = document.createElement("div"); field.className = "skill-field"; const title = document.createElement("label"); title.textContent = label; field.append(title); return field; }

function appendSkillField(label, value, container, className = "") { const field = createSkillField(label); const content = document.createElement("div"); content.className = className; content.textContent = value; field.append(content); container.append(field); }

function skillBadge(text, kind = "") { const badge = document.createElement("span"); badge.className = `skill-badge ${kind}`.trim(); badge.textContent = text; return badge; }

function skillButton(text, handler, className = "") { const button = document.createElement("button"); button.type = "button"; button.className = className; button.textContent = text; button.addEventListener("click", handler); return button; }

function skillUpdateKey(install) { return `${install.scope}\0${install.package}`; }

function scopeLabel(scope) { return scope === "global" ? "全局" : "当前项目"; }

function shortSkillVersion(value) { return value ? String(value).slice(0, 10) : "未知"; }

function skillUpdateLabel(update) { if (update.state === "update-available") return `发现新版本 ${shortSkillVersion(update.latestVersion)}`; if (update.state === "up-to-date") return "已是最新"; if (update.state === "unsupported") return "暂不支持自动检查"; if (update.state === "error") return update.message || "检查失败"; return "检查中……"; }

function formatSkillInstalls(count) { const value = Number(count || 0); if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M 次安装`; if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K 次安装`; return value ? `${value} 次安装` : "安装量未知"; }
  return { loadSkills, renderSkills, renderSkillsList, renderSkillDetail, renderManagedSkillActions, renderCustomSkillEditor, renderSkillAddPanel, renderSkillMarketPanel, renderSkillSearchResult, renderNewCustomSkillPanel, searchSkillMarket, installSkill, updateSkill, uninstallSkill, toggleSkillInvocation, saveCustomSkill, createCustomSkill, deleteCustomSkill, checkSkillUpdates, runSkillMutation, renderSkillDiagnostics, createExpandableSkillField, createSkillField, appendSkillField, skillBadge, skillButton, skillUpdateKey, scopeLabel, shortSkillVersion, skillUpdateLabel, formatSkillInstalls };
}
