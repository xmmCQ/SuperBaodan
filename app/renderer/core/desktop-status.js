const desktop = window.workbench;
let backendNotice = null;

function showBackendStatus(status) {
  if (!desktop || !document.body) return;
  document.body.inert = status.state === "stopping";
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

desktop?.onBackendStatus(showBackendStatus);
