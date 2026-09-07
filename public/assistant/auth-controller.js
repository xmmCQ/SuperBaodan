export function createAuthController({
  state,
  elements: el,
  api,
  uiDialogs,
  showNotice,
  showError,
  showSettingsToast,
  loadBootstrap,
  loadModelCatalog
}) {
  const AUTH_TEXT_TRANSLATIONS = new Map([
  ["Complete login in your browser, or paste the authorization code / redirect URL here:", "请在浏览器中完成登录，或在此粘贴授权码或重定向地址："],
  ["Complete sign-in in your browser, or paste the authorization code / redirect URL here:", "请在浏览器中完成登录，或在此粘贴授权码或重定向地址："],
  ["Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.", "请在浏览器中完成登录。如果浏览器位于其他设备，请在此粘贴最终重定向地址。"],
  ["Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.", "请在浏览器中完成登录。如果浏览器位于其他设备，请在此粘贴最终重定向地址。"],
  ["A browser window should open. Complete login to finish.", "已打开浏览器窗口，请在浏览器中完成登录。"],
  ["Continue in your browser.", "请在浏览器中继续完成登录。"],
  ["Select OpenAI Codex login method:", "请选择 OpenAI Codex 登录方式："],
  ["Browser login (default)", "浏览器登录（默认）"],
  ["Device code login (headless)", "设备码登录"],
  ["GitHub Enterprise URL/domain (blank for github.com)", "GitHub Enterprise 地址或域名（留空则使用 github.com）"],
  ["Enabling models...", "正在启用模型……"],
  ["Exchanging authorization code for tokens...", "正在使用授权码获取令牌……"],
  ["Exchanging authorization code for an API key...", "正在使用授权码获取 API Key……"],
  ["Invalid device token response", "设备令牌响应无效"],
  ["Device authorization expired.", "设备授权已过期。"],
  ["Device authorization was denied.", "设备授权已被拒绝。"],
  ["Kimi Code device authorization expired. Please restart login.", "Kimi Code 设备授权已过期，请重新登录。"],
  ["Kimi Code login was denied.", "Kimi Code 登录已被拒绝。"],
  ["xAI device authorization was denied", "xAI 设备授权已被拒绝"],
  ["xAI device code expired", "xAI 设备码已过期"],
  ["Login cancelled", "登录已取消"],
  ["State mismatch", "登录状态校验不一致"],
  ["OAuth state mismatch", "OAuth 登录状态校验不一致"],
  ["Missing authorization code", "缺少授权码"],
  ["Missing OAuth state", "缺少 OAuth 登录状态"],
]);
const COMMON_PROVIDER_ORDER = {
  oauth: ["openai-codex"],
  "api-key": ["openai", "deepseek", "kimi-coding"],
};
const DIRECT_LOGIN_WINDOW_PROVIDERS = new Set(["anthropic", "kimi-coding", "openrouter", "xai"]);
const LOGIN_WINDOW_METHODS = new Set(["browser", "device_code", "device-code"]);
let providerCatalog = { oauth: [], "api-key": [] };
let loginPopup = null;
el.providerSearch?.addEventListener("input", renderProviderCatalog);

function closeLoginPopup() {
  const popup = loginPopup;
  loginPopup = null;
  if (popup && !popup.closed) popup.close();
}

function prepareLoginPopup(providerId) {
  closeLoginPopup();
  const popup = window.open("about:blank", "_blank");
  if (!popup) return false;
  loginPopup = popup;
  try {
    popup.opener = null;
    popup.document.title = "正在打开登录页面";
    popup.document.body.textContent = `正在获取 ${providerId === "openai-codex" ? "ChatGPT" : providerId} 登录地址，请稍候……`;
  } catch {}
  return true;
}

function navigateLoginPopup(url) {
  const popup = loginPopup;
  if (!popup || popup.closed) { loginPopup = null; return false; }
  try {
    popup.location.href = url;
    return true;
  } catch {
    loginPopup = null;
    return false;
  }
}

async function loadAccounts() {
  const data = await api("/api/auth/providers");
  providerCatalog = {
    oauth: data.oauthProviders || [],
    "api-key": data.apiKeyProviders || [],
  };
  renderProviderCatalog();
}

function providerConfigured(provider, type) {
  return type === "oauth" ? Boolean(provider.loggedIn) : Boolean(provider.configured);
}

function providerIsCommon(provider, type) {
  return COMMON_PROVIDER_ORDER[type].includes(provider.id);
}

function sortProviders(providers, type) {
  const commonOrder = COMMON_PROVIDER_ORDER[type];
  return [...providers].sort((left, right) => {
    const configuredDifference = Number(providerConfigured(right, type)) - Number(providerConfigured(left, type));
    if (configuredDifference) return configuredDifference;
    const leftCommon = commonOrder.indexOf(left.id); const rightCommon = commonOrder.indexOf(right.id);
    if (leftCommon !== rightCommon) {
      if (leftCommon < 0) return 1;
      if (rightCommon < 0) return -1;
      return leftCommon - rightCommon;
    }
    return String(left.name || left.id).localeCompare(String(right.name || right.id), "zh-CN");
  });
}

function renderProviderCatalog() {
  const query = (el.providerSearch?.value || "").trim().toLocaleLowerCase();
  const filter = (providers) => providers.filter((provider) => !query || `${provider.name || ""} ${provider.id}`.toLocaleLowerCase().includes(query));
  const oauth = sortProviders(filter(providerCatalog.oauth), "oauth");
  const apiKey = sortProviders(filter(providerCatalog["api-key"]), "api-key");
  const mainOauth = oauth.filter((provider) => providerConfigured(provider, "oauth") || providerIsCommon(provider, "oauth"));
  const mainApiKey = apiKey.filter((provider) => providerConfigured(provider, "api-key") || providerIsCommon(provider, "api-key"));
  const moreOauth = oauth.filter((provider) => !mainOauth.includes(provider));
  const moreApiKey = apiKey.filter((provider) => !mainApiKey.includes(provider));
  renderProviderCards(el.oauthProviders, mainOauth, "oauth", false);
  renderProviderCards(el.apiKeyProviders, mainApiKey, "api-key", false);
  renderProviderCards(el.moreOauthProviders, moreOauth, "oauth", false);
  renderProviderCards(el.moreApiKeyProviders, moreApiKey, "api-key", false);
  el.oauthProviderGroup.classList.toggle("hidden", !mainOauth.length);
  el.apiKeyProviderGroup.classList.toggle("hidden", !mainApiKey.length);
  el.moreOauthGroup.classList.toggle("hidden", !moreOauth.length);
  el.moreApiKeyGroup.classList.toggle("hidden", !moreApiKey.length);
  const moreCount = moreOauth.length + moreApiKey.length;
  el.moreProviderCount.textContent = moreCount ? `（${moreCount}）` : "";
  el.moreProviders.classList.toggle("hidden", !moreCount);
  el.moreProviders.open = Boolean(query && moreCount);
  el.providerSearchEmpty.classList.toggle("hidden", Boolean(mainOauth.length + mainApiKey.length + moreCount));
}

function renderProviderCards(container, providers, type, showEmpty = true) {
  container.replaceChildren();
  for (const provider of providers) {
    const common = providerIsCommon(provider, type);
    const card = document.createElement("article"); card.className = `provider-card${common ? " common" : ""}`;
    const head = document.createElement("div"); head.className = "provider-card-head";
    const titleWrap = document.createElement("div"); titleWrap.className = "provider-card-title";
    const title = document.createElement("b"); title.textContent = provider.name;
    titleWrap.append(title);
    if (common) { const badge = document.createElement("span"); badge.className = "provider-common-badge"; badge.textContent = "常用"; titleWrap.append(badge); }
    const status = document.createElement("span");
    const configured = providerConfigured(provider, type);
    status.className = configured ? "status-ok" : "status-off";
    status.textContent = type === "oauth" ? (configured ? "已登录" : "未登录") : (configured ? "已设置" : "未设置");
    head.append(titleWrap, status);
    const meta = document.createElement("small"); meta.className = "muted"; meta.textContent = `${provider.modelCount || 0} 个模型 · ${provider.id}`;
    const actions = document.createElement("div"); actions.className = "provider-card-actions";
    const button = document.createElement("button"); button.className = type === "oauth" && configured ? "danger-lite" : "primary";
    button.textContent = type === "oauth" ? (configured ? "退出" : "登录") : "设置API";
    if (type === "oauth") button.addEventListener("click", () => configured ? logoutProvider(provider.id, "oauth") : startOAuthLogin(provider));
    else button.addEventListener("click", () => requestApiKey(provider));
    actions.append(button); card.append(head, meta, actions); container.append(card);
  }
  if (showEmpty && !providers.length) { const empty = document.createElement("div"); empty.className = "muted"; empty.textContent = "暂无可用供应商"; container.append(empty); }
}

async function logoutProvider(providerId, type) {
  if (!await uiDialogs.confirm(`确定退出 ${providerId} 吗？`, { title: "退出账号", danger: true, confirmText: "退出" })) return;
  try {
    const url = type === "oauth" ? `/api/auth/logout/${encodeURIComponent(providerId)}` : `/api/auth/api-key/${encodeURIComponent(providerId)}`;
    await api(url, { method: type === "oauth" ? "POST" : "DELETE", body: "{}" });
    showNotice("已退出登录");
    await Promise.all([loadAccounts(), loadBootstrap()]);
  } catch (error) { showError(error); }
}

function localizeAuthText(value) {
  if (!value) return "";
  const text = String(value);
  if (AUTH_TEXT_TRANSLATIONS.has(text)) return AUTH_TEXT_TRANSLATIONS.get(text);
  const replacements = [
    [/^Listening for (.+?) callback on (.+)$/i, (_, type, url) => `正在等待 ${type} 回调：${url}`],
    [/^Sign in to (.+):$/i, (_, name) => `登录 ${name}：`],
    [/^Device flow failed:\s*(.+)$/i, (_, reason) => `设备授权失败：${reason}`],
    [/^Unknown OpenAI Codex login method:\s*(.+)$/i, (_, method) => `未知的 OpenAI Codex 登录方式：${method}`],
  ];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  return text;
}

function startOAuthLogin(provider) {
  state.activeLoginSource?.close();
  if (DIRECT_LOGIN_WINDOW_PROVIDERS.has(provider.id)) prepareLoginPopup(provider.id);
  else closeLoginPopup();
  const source = new EventSource(`/api/auth/login/${encodeURIComponent(provider.id)}`);
  state.activeLoginSource = source;
  el.loginProgress.classList.remove("hidden");
  el.loginProgress.textContent = `正在连接 ${provider.name}……`;
  source.onmessage = (message) => {
    let event;
    try { event = JSON.parse(message.data); } catch { return; }
    if (event.type === "auth") renderOAuthAction(provider, event);
    else if (event.type === "device_code") renderDeviceCode(provider, event);
    else if (event.type === "input") renderOAuthInput(provider, event);
    else if (event.type === "progress") el.loginProgress.textContent = localizeAuthText(event.message) || "正在登录……";
    else if (event.type === "success") {
      source.close(); state.activeLoginSource = null; loginPopup = null;
      el.loginProgress.textContent = `${provider.name} 登录成功，正在刷新模型……`;
      Promise.all([loadAccounts(), loadBootstrap(), loadModelCatalog()]).then(() => showNotice("登录成功，模型已刷新")).catch(showError);
    } else if (event.type === "error" || event.type === "cancelled") {
      source.close(); state.activeLoginSource = null; closeLoginPopup();
      el.loginProgress.textContent = localizeAuthText(event.message) || (event.type === "cancelled" ? "登录已取消" : "登录失败");
    }
  };
  source.onerror = () => {
    if (state.activeLoginSource === source) el.loginProgress.textContent = "登录连接中断；如已完成授权，请重新打开账号页刷新状态";
  };
}

function renderOAuthAction(provider, event) {
  el.loginProgress.replaceChildren();
  const opened = navigateLoginPopup(event.url);
  const text = document.createElement("div"); text.textContent = opened
    ? localizeAuthText(event.instructions) || `已打开浏览器窗口，请完成 ${provider.name} 授权`
    : "浏览器未能自动打开，请点击下方链接完成授权";
  const link = document.createElement("a"); link.href = event.url; link.target = "_blank"; link.rel = "noopener"; link.textContent = opened ? "重新打开授权页面" : "打开授权页面";
  el.loginProgress.append(text, link);
  if (event.token) renderLoginInputControls(provider.id, event.token, "粘贴授权后的完整地址或授权码", null);
}

function renderDeviceCode(provider, event) {
  el.loginProgress.replaceChildren();
  const opened = navigateLoginPopup(event.verificationUri);
  const text = document.createElement("div"); text.textContent = `${provider.name} 设备码：${event.userCode}`;
  const link = document.createElement("a"); link.href = event.verificationUri; link.target = "_blank"; link.rel = "noopener"; link.textContent = opened ? "重新打开验证页面" : "打开验证页面";
  const copy = document.createElement("button"); copy.textContent = "复制设备码"; copy.addEventListener("click", () => navigator.clipboard?.writeText(event.userCode));
  el.loginProgress.append(text, link, copy);
}

function renderOAuthInput(provider, event) {
  el.loginProgress.replaceChildren();
  const text = document.createElement("div"); text.textContent = localizeAuthText(event.message) || "请继续登录"; el.loginProgress.append(text);
  renderLoginInputControls(provider.id, event.token, localizeAuthText(event.placeholder) || "输入授权结果", event.options);
}

function renderLoginInputControls(providerId, token, placeholder, options) {
  if (Array.isArray(options) && options.length) {
    const wrap = document.createElement("div"); wrap.className = "provider-card-actions";
    for (const option of options) {
      const button = document.createElement("button"); button.textContent = localizeAuthText(option.label) || option.id;
      button.addEventListener("click", async () => {
        const opensLoginPage = LOGIN_WINDOW_METHODS.has(option.id);
        if (opensLoginPage) prepareLoginPopup(providerId);
        const submitted = await submitLoginInput(providerId, token, option.id);
        if (opensLoginPage && !submitted) closeLoginPopup();
      });
      wrap.append(button);
    }
    el.loginProgress.append(wrap); return;
  }
  const input = document.createElement("input"); input.placeholder = placeholder; input.autocomplete = "off";
  const button = document.createElement("button"); button.textContent = "提交";
  button.addEventListener("click", async () => {
    const opensLoginPage = providerId === "github-copilot";
    if (opensLoginPage) prepareLoginPopup(providerId);
    const submitted = await submitLoginInput(providerId, token, input.value);
    if (opensLoginPage && !submitted) closeLoginPopup();
  });
  el.loginProgress.append(input, button);
}

async function submitLoginInput(providerId, token, value) {
  try {
    await api(`/api/auth/login/${encodeURIComponent(providerId)}/input`, { method: "POST", body: JSON.stringify({ token, value }) });
    el.loginProgress.textContent = "正在验证……";
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}

function requestApiKey(provider) {
  state.secretProvider = provider;
  el.secretDialogTitle.textContent = `设置API · ${provider.name}`;
  el.secretInput.value = "";
  el.secretDialog.showModal();
  el.secretInput.focus();
}

function cancelSecretInput() { state.secretProvider = null; el.secretDialog.close(); }

async function submitSecretInput() {
  const provider = state.secretProvider;
  if (!provider || !el.secretInput.value.trim()) return;
  el.submitSecret.disabled = true;
  try {
    await api(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, { method: "POST", body: JSON.stringify({ apiKey: el.secretInput.value }) });
    el.secretInput.value = ""; state.secretProvider = null; el.secretDialog.close();
    await Promise.all([loadAccounts(), loadBootstrap()]); showSettingsToast("保存成功");
  } catch (error) { showError(error); }
  finally { el.submitSecret.disabled = false; }
}
  function closeActiveLogin() { state.activeLoginSource?.close(); state.activeLoginSource = null; closeLoginPopup(); }
  return { closeActiveLogin, loadAccounts, renderProviderCards, logoutProvider, localizeAuthText, startOAuthLogin, renderOAuthAction, renderDeviceCode, renderOAuthInput, renderLoginInputControls, submitLoginInput, requestApiKey, cancelSecretInput, submitSecretInput };
}
