const desktop = window.superBaodanDesktop;
let closeStateProvider = null;
let backendNotice = null;

function normalizeCloseState(value) {
  const reasons = Array.isArray(value?.reasons) ? value.reasons.filter(item => typeof item === "string" && item.trim()).slice(0, 12) : [];
  return { unsaved: Boolean(value?.unsaved), busy: Boolean(value?.busy), reasons };
}

function getCloseState() {
  if (!closeStateProvider) return { unsaved: false, busy: false, reasons: [] };
  return Promise.resolve(closeStateProvider()).then(normalizeCloseState);
}

function registerCloseState(provider) {
  if (typeof provider !== "function") throw new TypeError("关闭状态提供器必须是函数");
  closeStateProvider = provider;
  return () => { if (closeStateProvider === provider) closeStateProvider = null; };
}

async function requestExit({ confirmBrowser, shutdownBrowser, afterBrowserExit } = {}) {
  if (desktop?.isDesktop) return desktop.requestExit();
  if (confirmBrowser && !await confirmBrowser()) return { ok: false, cancelled: true, mode: "browser" };
  await shutdownBrowser?.();
  await afterBrowserExit?.();
  return { ok: true, mode: "browser" };
}

function showBackendStatus(status) {
  if (!desktop?.isDesktop || !document.body) return;
  if (status.state === "connected") {
    backendNotice?.remove(); backendNotice = null;
    return;
  }
  if (!backendNotice) {
    backendNotice = document.createElement("aside");
    backendNotice.setAttribute("role", "alert");
    Object.assign(backendNotice.style, {
      position: "fixed", inset: "14px 14px auto auto", zIndex: "2147483647", maxWidth: "420px",
      padding: "14px 16px", borderRadius: "12px", color: "#fff", background: "#6f3d31",
      boxShadow: "0 12px 36px rgba(0,0,0,.24)", font: "14px/1.5 'Microsoft YaHei UI',sans-serif",
    });
    document.body.append(backendNotice);
  }
  backendNotice.replaceChildren();
  const text = document.createElement("span");
  text.textContent = status.message || (status.state === "stopping" ? "正在安全退出……" : "后台服务已断开");
  backendNotice.append(text);
  if (status.state === "disconnected") {
    const actions = document.createElement("div"); actions.style.marginTop = "10px";
    for (const [label, action] of [["重试", () => desktop.retryStartup()], ["查看日志", () => desktop.openLogs()]]) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.style.marginRight = "8px";
      button.addEventListener("click", () => Promise.resolve(action()).catch((error) => { text.textContent = error.message; }));
      actions.append(button);
    }
    backendNotice.append(actions);
  }
}

function hideDesktopExitActions() {
  if (!desktop?.isDesktop) return;
  for (const node of document.querySelectorAll("#exitWorkbenchButton, #exitWorkbench")) {
    node.hidden = true;
    node.setAttribute("aria-hidden", "true");
  }
}

desktop?.onBackendStatus(showBackendStatus);
hideDesktopExitActions();
document.addEventListener("DOMContentLoaded", hideDesktopExitActions, { once: true });

window.superBaodanDesktopRuntime = Object.freeze({
  isDesktop: Boolean(desktop?.isDesktop),
  registerCloseState,
  getCloseState,
  requestExit,
  openExternal: (url) => desktop?.openExternal(url),
});
