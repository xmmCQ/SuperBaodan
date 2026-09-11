export function createModelsController({
  state,
  elements: el,
  api,
  command,
  uiDialogs,
  showNotice,
  showError,
  showSettingsToast,
  loadBootstrap,
  updateStateFromAgent
}) {
  let availableModels = [];
  const validModel = (model) => Boolean(model?.provider && model?.id && model.provider !== "unknown" && model.id !== "unknown");
  const KEEP_SECRET = "__SUPER_BAODAN_KEEP_SECRET__";
  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
async function resolveEnabledModels(bootstrapEnabledModels) {
  if (Array.isArray(bootstrapEnabledModels)) return bootstrapEnabledModels;
  try {
    const catalog = await api("/api/models/catalog");
    return Array.isArray(catalog.enabledModels) ? catalog.enabledModels : [];
  } catch (error) {
    console.warn("读取模型显示设置失败", error);
    return [];
  }
}

async function switchModel(provider, modelId) {
  if (!provider || !modelId) return;
  el.modelPickerPanel.classList.add("hidden");
  try {
    await command({ type: "set_model", provider, modelId });
    const [agentState, thinking] = await Promise.all([
      command({ type: "get_state" }),
      command({ type: "get_available_thinking_levels" }),
    ]);
    state.currentModel = { provider, id: modelId };
    updateStateFromAgent(agentState || {});
    renderThinking(thinking?.levels || ["off"], agentState?.thinkingLevel || "off");
    renderModelPicker();
    updateModelPickerButton();
    showNotice(`已切换模型：${modelId}`);
  } catch (error) { showError(error); }
}

async function switchThinking() {
  const requested = el.thinkingSelect.value;
  try {
    await command({ type: "set_thinking_level", level: requested });
    const agentState = await command({ type: "get_state" });
    if (agentState?.thinkingLevel) el.thinkingSelect.value = agentState.thinkingLevel;
  } catch (error) {
    const [agentState, thinking] = await Promise.all([
      command({ type: "get_state" }).catch(() => ({})),
      command({ type: "get_available_thinking_levels" }).catch(() => ({ levels: ["off"] })),
    ]);
    renderThinking(thinking?.levels || ["off"], agentState?.thinkingLevel || "off");
    showError(error);
  }
}

function renderModels(models, current) {
  availableModels = models.filter(validModel);
  models = availableModels;
  const enabled = state.enabledModels;
  const visible = !enabled.length ? models : models.filter((model) => {
    const key = `${model.provider}/${model.id}`;
    return enabled.some((pattern) => modelScopeMatches(pattern, key, model.id));
  });
  state.models = [...visible].sort((a, b) => `${a.provider}/${a.name || a.id}`.localeCompare(`${b.provider}/${b.name || b.id}`, undefined, { numeric: true }));
  state.currentModel = validModel(current) ? { provider: current.provider, id: current.id } : null;
  renderModelPicker();
  updateModelPickerButton();
}

function renderModelPicker() {
  const query = (el.modelFilter.value || "").trim().toLocaleLowerCase();
  const filtered = state.models.filter((model) => `${model.name || ""} ${model.id} ${model.provider}`.toLocaleLowerCase().includes(query));
  el.modelPickerList.replaceChildren();
  let provider = null;
  for (const model of filtered) {
    if (model.provider !== provider) {
      provider = model.provider;
      const heading = document.createElement("div");
      heading.className = "model-group-title";
      heading.textContent = provider === "openai-codex" ? "ChatGPT Plus/Pro · openai-codex" : provider;
      el.modelPickerList.append(heading);
    }
    const button = document.createElement("button");
    button.className = `model-option ${state.currentModel?.provider === model.provider && state.currentModel?.id === model.id ? "active" : ""}`;
    const name = document.createElement("b"); name.textContent = model.name || model.id;
    const id = document.createElement("small"); id.textContent = model.id;
    button.append(name, id);
    button.addEventListener("click", () => switchModel(model.provider, model.id));
    el.modelPickerList.append(button);
  }
  if (!filtered.length) {
    const empty = document.createElement("div"); empty.className = "muted"; empty.textContent = "没有匹配模型"; el.modelPickerList.append(empty);
  }
}

function updateModelPickerButton() {
  const current = state.models.find((model) => model.provider === state.currentModel?.provider && model.id === state.currentModel?.id);
  const selected = availableModels.find((model) => model.provider === state.currentModel?.provider && model.id === state.currentModel?.id);
  const hasModels = availableModels.length > 0;
  el.modelPickerButton.closest(".model-picker").classList.toggle("hidden", !hasModels);
  el.thinkingSelect.classList.toggle("hidden", !hasModels || !selected);
  if (!hasModels) el.modelPickerPanel.classList.add("hidden");
  const display = current || selected;
  el.modelPickerButton.textContent = display ? `${display.name || display.id} · ${display.provider}` : "选择模型";
}

function renderThinking(levels, current) {
  const available = new Set(levels?.length ? levels : ["off"]);
  if (current) available.add(current);
  el.thinkingSelect.replaceChildren();
  for (const level of THINKING_LEVELS.filter((item) => available.has(item))) el.thinkingSelect.append(new Option(level, level, false, level === current));
}

async function loadModelsConfig() {
  state.modelsConfig = await api("/api/models/config");
  if (!state.modelsConfig.providers || typeof state.modelsConfig.providers !== "object") state.modelsConfig.providers = {};
  state.providerKey = Object.keys(state.modelsConfig.providers)[0] || null;
  state.modelIndex = 0;
  renderConfigSelectors();
  commitProviderForm();
  state.modelsConfigSnapshot = JSON.stringify(state.modelsConfig);
}

function renderConfigSelectors() {
  el.providerConfigSelect.replaceChildren();
  for (const key of Object.keys(state.modelsConfig?.providers || {})) el.providerConfigSelect.append(new Option(key, key, false, key === state.providerKey));
  if (!state.providerKey) {
    el.providerConfigSelect.append(new Option("暂无供应商", ""));
    clearProviderForm(); clearModelForm(); return;
  }
  loadProviderForm();
  const models = state.modelsConfig.providers[state.providerKey].models || [];
  el.modelConfigSelect.replaceChildren();
  models.forEach((model, index) => el.modelConfigSelect.append(new Option(model.name || model.id || `模型 ${index + 1}`, String(index), false, index === state.modelIndex)));
  if (!models.length) el.modelConfigSelect.append(new Option("暂无模型", ""));
  loadModelForm();
}

function loadProviderForm() {
  const provider = state.modelsConfig.providers[state.providerKey] || {};
  el.providerId.value = state.providerKey || ""; el.providerName.value = provider.name || ""; el.providerBaseUrl.value = provider.baseUrl || "";
  setSelectValue(el.providerApi, provider.api || "");
  el.providerApiKey.value = ""; el.providerApiKey.dataset.keepSecret = provider.apiKey === KEEP_SECRET ? "true" : "false";
  el.providerAuthHeader.checked = Boolean(provider.authHeader);
  el.providerHeaders.value = JSON.stringify(provider.headers || {}, null, 2); el.providerCompat.value = JSON.stringify(provider.compat || {}, null, 2);
}

function loadModelForm() {
  const model = state.modelsConfig?.providers?.[state.providerKey]?.models?.[state.modelIndex];
  if (!model) return clearModelForm();
  el.modelId.value = model.id || ""; el.modelName.value = model.name || ""; el.modelApi.value = model.api || ""; el.modelReasoning.checked = Boolean(model.reasoning);
  const input = model.input || ["text"]; el.modelInputText.checked = input.includes("text"); el.modelInputImage.checked = input.includes("image");
  el.modelContextWindow.value = model.contextWindow ?? ""; el.modelMaxTokens.value = model.maxTokens ?? "";
  el.costInput.value = model.cost?.input ?? ""; el.costOutput.value = model.cost?.output ?? ""; el.costCacheRead.value = model.cost?.cacheRead ?? ""; el.costCacheWrite.value = model.cost?.cacheWrite ?? "";
  el.modelThinkingMap.value = JSON.stringify(model.thinkingLevelMap || {}, null, 2); el.modelCompat.value = JSON.stringify(model.compat || {}, null, 2);
}

function clearProviderForm() { for (const id of ["providerId", "providerName", "providerBaseUrl", "providerApiKey"]) el[id].value = ""; el.providerHeaders.value = "{}"; el.providerCompat.value = "{}"; }

function clearModelForm() { for (const id of ["modelId", "modelName", "modelApi", "modelContextWindow", "modelMaxTokens", "costInput", "costOutput", "costCacheRead", "costCacheWrite"]) el[id].value = ""; el.modelThinkingMap.value = "{}"; el.modelCompat.value = "{}"; }

function parseJsonField(element, label) { try { const value = JSON.parse(element.value || "{}"); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("必须是对象"); return value; } catch (error) { throw new Error(`${label}不是有效 JSON：${error.message}`); } }

function numberOrUndefined(element) { return element.value === "" ? undefined : Number(element.value); }

function setSelectValue(select, value) { if (value && ![...select.options].some((option) => option.value === value)) select.append(new Option(value, value)); select.value = value; }

function commitModelForm() {
  const models = state.modelsConfig?.providers?.[state.providerKey]?.models;
  if (!models?.[state.modelIndex]) return;
  const old = models[state.modelIndex];
  const costValues = [el.costInput, el.costOutput, el.costCacheRead, el.costCacheWrite].map(numberOrUndefined);
  const next = {
    ...old, id: el.modelId.value.trim(), name: el.modelName.value.trim() || el.modelId.value.trim(),
    reasoning: el.modelReasoning.checked, input: [el.modelInputText.checked && "text", el.modelInputImage.checked && "image"].filter(Boolean),
  };
  assignOrDelete(next, "api", el.modelApi.value.trim()); assignOrDelete(next, "contextWindow", numberOrUndefined(el.modelContextWindow)); assignOrDelete(next, "maxTokens", numberOrUndefined(el.modelMaxTokens));
  if (costValues.some((value) => value !== undefined)) next.cost = { ...(old.cost || {}), input: costValues[0] ?? 0, output: costValues[1] ?? 0, cacheRead: costValues[2] ?? 0, cacheWrite: costValues[3] ?? 0 }; else delete next.cost;
  const thinkingMap = parseJsonField(el.modelThinkingMap, "思考等级映射"); const compat = parseJsonField(el.modelCompat, "模型兼容参数");
  if (Object.keys(thinkingMap).length) next.thinkingLevelMap = thinkingMap; else delete next.thinkingLevelMap;
  if (Object.keys(compat).length) next.compat = compat; else delete next.compat;
  models[state.modelIndex] = next;
}

function commitProviderForm() {
  if (!state.providerKey) return;
  commitModelForm();
  const oldKey = state.providerKey; const old = state.modelsConfig.providers[oldKey]; const newKey = el.providerId.value.trim();
  if (!newKey) throw new Error("供应商ID不能为空");
  const next = { ...old };
  assignOrDelete(next, "name", el.providerName.value.trim()); assignOrDelete(next, "baseUrl", el.providerBaseUrl.value.trim()); assignOrDelete(next, "api", el.providerApi.value);
  if (el.providerApiKey.value.trim()) next.apiKey = el.providerApiKey.value.trim(); else if (el.providerApiKey.dataset.keepSecret !== "true") delete next.apiKey;
  if (el.providerAuthHeader.checked) next.authHeader = true; else delete next.authHeader;
  const headers = parseJsonField(el.providerHeaders, "附加请求头"); const compat = parseJsonField(el.providerCompat, "供应商兼容参数");
  if (Object.keys(headers).length) next.headers = headers; else delete next.headers;
  if (Object.keys(compat).length) next.compat = compat; else delete next.compat;
  if (newKey !== oldKey) { if (state.modelsConfig.providers[newKey]) throw new Error(`供应商ID已存在：${newKey}`); delete state.modelsConfig.providers[oldKey]; state.modelsConfig.providers[newKey] = next; state.providerKey = newKey; } else state.modelsConfig.providers[oldKey] = next;
}

function assignOrDelete(object, key, value) { if (value === "" || value === undefined || value === null || Number.isNaN(value)) delete object[key]; else object[key] = value; }

function changeProviderConfig() { try { commitProviderForm(); state.providerKey = el.providerConfigSelect.value; state.modelIndex = 0; renderConfigSelectors(); } catch (error) { showError(error); renderConfigSelectors(); } }

function changeModelConfig() { try { commitModelForm(); state.modelIndex = Number(el.modelConfigSelect.value || 0); loadModelForm(); } catch (error) { showError(error); } }

function addProviderConfig() { try { commitProviderForm(); let n = 1; let id = "custom-provider"; while (state.modelsConfig.providers[id]) id = `custom-provider-${++n}`; state.modelsConfig.providers[id] = { baseUrl: "", api: "openai-completions", models: [] }; state.providerKey = id; state.modelIndex = 0; renderConfigSelectors(); } catch (error) { showError(error); } }

async function deleteProviderConfig() { if (!state.providerKey || !await uiDialogs.confirm(`删除供应商 ${state.providerKey}？`, { title: "删除供应商", danger: true, confirmText: "删除" })) return; delete state.modelsConfig.providers[state.providerKey]; state.providerKey = Object.keys(state.modelsConfig.providers)[0] || null; state.modelIndex = 0; renderConfigSelectors(); }

function addModelConfig() { try { commitProviderForm(); const models = state.modelsConfig.providers[state.providerKey].models ||= []; let n = models.length + 1; models.push({ id: `model-${n}`, name: `Model ${n}`, input: ["text"] }); state.modelIndex = models.length - 1; renderConfigSelectors(); } catch (error) { showError(error); } }

function duplicateModelConfig() { try { commitProviderForm(); const models = state.modelsConfig.providers[state.providerKey]?.models || []; if (!models[state.modelIndex]) return; const copy = structuredClone(models[state.modelIndex]); copy.id = `${copy.id}-copy`; copy.name = `${copy.name || copy.id} Copy`; models.splice(state.modelIndex + 1, 0, copy); state.modelIndex++; renderConfigSelectors(); } catch (error) { showError(error); } }

async function deleteModelConfig() { const models = state.modelsConfig?.providers?.[state.providerKey]?.models || []; if (!models[state.modelIndex] || !await uiDialogs.confirm(`删除模型 ${models[state.modelIndex].id}？`, { title: "删除模型", danger: true, confirmText: "删除" })) return; models.splice(state.modelIndex, 1); state.modelIndex = Math.max(0, Math.min(state.modelIndex, models.length - 1)); renderConfigSelectors(); }

async function saveModelsConfig() {
  try {
    commitProviderForm();
    if (JSON.stringify(state.modelsConfig) === state.modelsConfigSnapshot) return showSettingsToast("未修改", "unchanged");
    await api("/api/models/config", { method: "PUT", body: JSON.stringify(state.modelsConfig) });
    state.modelsConfig = null;
    await Promise.all([loadModelsConfig(), loadBootstrap(), loadModelCatalog()]);
    showSettingsToast("保存成功");
  } catch (error) { showSettingsToast(error?.message || "保存失败", "error"); showError(error); }
}

async function testConfiguredModel() {
  try { commitProviderForm(); const provider = state.modelsConfig.providers[state.providerKey]; const model = provider.models?.[state.modelIndex]; if (!model) throw new Error("请先选择模型"); el.testModelResult.textContent = "正在测试……"; const result = await api("/api/models/test", { method: "POST", body: JSON.stringify({ providerName: state.providerKey, provider, model }) }); el.testModelResult.textContent = `成功 · ${result.latencyMs}ms · ${result.responseText || "OK"}`; }
  catch (error) { el.testModelResult.textContent = `失败：${error.message}`; showError(error); }
}

async function loadModelCatalog() { state.catalog = await api("/api/models/catalog"); renderModelPreferences(); }

function renderModelPreferences() {
  const catalog = state.catalog || { models: [] }; const enabled = catalog.enabledModels || [];
  el.defaultModelSelect.replaceChildren();
  let group = null; let optgroup;
  for (const model of catalog.models) {
    if (model.provider !== group) { group = model.provider; optgroup = document.createElement("optgroup"); optgroup.label = group === "openai-codex" ? "ChatGPT Plus/Pro" : group; el.defaultModelSelect.append(optgroup); }
    const option = new Option(model.name || model.id, `${model.provider}||${model.id}`); option.selected = catalog.defaultModel?.provider === model.provider && catalog.defaultModel?.modelId === model.id; optgroup.append(option);
  }
  el.modelPreferencesList.replaceChildren();
  for (const model of catalog.models) {
    const key = `${model.provider}/${model.id}`; const row = document.createElement("div"); row.className = "preference-row"; row.dataset.modelKey = key;
    const visible = document.createElement("input"); visible.type = "checkbox"; visible.className = "model-visible"; visible.checked = !enabled.length || enabled.some((pattern) => modelScopeMatches(pattern, key, model.id));
    const name = document.createElement("div"); const strong = document.createElement("b"); strong.textContent = model.name || model.id; const small = document.createElement("small"); small.textContent = ` ${key}`; name.append(strong, small);
    row.append(visible, name); el.modelPreferencesList.append(row);
  }
  syncDefaultModelPreference(catalog.defaultThinkingLevel || "off");
  state.preferencesSnapshot = modelPreferencesFormSnapshot();
}

function supportedThinkingLevels(model) {
  if (!model?.reasoning) return ["off"];
  const available = new Set(["off", "minimal", "low", "medium", "high"]);
  for (const [level, mapped] of Object.entries(model.thinkingLevelMap || {})) {
    if (mapped == null) available.delete(level); else available.add(level);
  }
  return THINKING_LEVELS.filter((level) => available.has(level));
}

function syncDefaultModelPreference(preferredLevel = el.defaultThinking.value) {
  const value = el.defaultModelSelect.value;
  const [provider, modelId] = value.split("||");
  const defaultKey = `${provider}/${modelId}`;
  for (const row of el.modelPreferencesList.querySelectorAll(".preference-row")) {
    const checkbox = row.querySelector(".model-visible");
    const isDefault = row.dataset.modelKey === defaultKey;
    row.classList.toggle("default-model", isDefault);
    checkbox.disabled = isDefault;
    if (isDefault) checkbox.checked = true;
  }
  const model = state.catalog?.models?.find((item) => item.provider === provider && item.id === modelId);
  const levels = supportedThinkingLevels(model);
  el.defaultThinking.replaceChildren(...levels.map((level) => new Option(level, level)));
  el.defaultThinking.value = levels.includes(preferredLevel) ? preferredLevel : levels.includes("high") ? "high" : levels[0] || "off";
}

function modelScopeMatches(pattern, key, id) { if (!pattern) return false; const base = String(pattern).split(":")[0]; if (!base.includes("*") && !base.includes("?")) return base === key || base === id; const regex = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i"); return regex.test(key) || regex.test(id); }

function updateModelVisibility(mode) {
  for (const checkbox of el.modelPreferencesList.querySelectorAll(".model-visible")) {
    if (checkbox.disabled) continue;
    checkbox.checked = mode === "all" ? true : !checkbox.checked;
  }
}

function modelPreferencesFormSnapshot() {
  const rows = [...el.modelPreferencesList.querySelectorAll(".preference-row")];
  return JSON.stringify({
    defaultModel: el.defaultModelSelect.value,
    defaultThinkingLevel: el.defaultThinking.value,
    visibleModels: rows.filter((row) => row.querySelector(".model-visible").checked).map((row) => row.dataset.modelKey),
    modelCount: rows.length,
  });
}

async function saveModelPreferences() {
  try {
    const snapshot = modelPreferencesFormSnapshot();
    if (snapshot === state.preferencesSnapshot) return showSettingsToast("未修改", "unchanged");
    const form = JSON.parse(snapshot);
    const [provider, modelId] = form.defaultModel.split("||");
    await api("/api/models/preferences", { method: "PUT", body: JSON.stringify({ defaultModel: { provider, modelId }, defaultThinkingLevel: form.defaultThinkingLevel, enabledModels: form.visibleModels.length === form.modelCount ? [] : form.visibleModels }) });
    await Promise.all([loadModelCatalog(), loadBootstrap()]);
    showSettingsToast("保存成功");
  } catch (error) { showSettingsToast(error?.message || "保存失败", "error"); showError(error); }
}
  function setEnabledModels(models) { state.enabledModels = Array.isArray(models) ? models : []; }
  function applyAgentState(agentState) {
    if (Object.prototype.hasOwnProperty.call(agentState || {}, "model")) state.currentModel = validModel(agentState.model) ? { provider: agentState.model.provider, id: agentState.model.id } : null;
    if (agentState?.thinkingLevel) el.thinkingSelect.value = agentState.thinkingLevel;
    updateModelPickerButton();
  }
  return { setEnabledModels, applyAgentState, resolveEnabledModels, switchModel, switchThinking, renderModels, renderModelPicker, updateModelPickerButton, renderThinking, loadModelsConfig, renderConfigSelectors, loadProviderForm, loadModelForm, clearProviderForm, clearModelForm, parseJsonField, numberOrUndefined, setSelectValue, commitModelForm, commitProviderForm, assignOrDelete, changeProviderConfig, changeModelConfig, addProviderConfig, deleteProviderConfig, addModelConfig, duplicateModelConfig, deleteModelConfig, saveModelsConfig, testConfiguredModel, loadModelCatalog, renderModelPreferences, supportedThinkingLevels, syncDefaultModelPreference, modelScopeMatches, updateModelVisibility, modelPreferencesFormSnapshot, saveModelPreferences };
}
