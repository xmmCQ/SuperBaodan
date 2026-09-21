const desktop = window.workbench;
const message = document.getElementById("message");
const retry = document.getElementById("retry");

desktop?.onStartupStatus((status) => {
  message.textContent = status.message || "正在启动工作台……";
  document.body.classList.toggle("error", status.state === "error");
  retry.disabled = status.state === "starting";
});

document.getElementById("retry").addEventListener("click", () => void desktop?.retryStartup());
document.getElementById("logs").addEventListener("click", () => void desktop?.openLogs());
document.getElementById("exit").addEventListener("click", () => void desktop?.requestExit());
