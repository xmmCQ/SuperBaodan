import { app, dialog, ipcMain, Menu, shell, Tray } from "electron";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BackendManager, isStartCancelled } from "./backend-manager.mjs";
import { resolveDesktopConfig } from "./config.mjs";
import { ExitCoordinator } from "./exit-coordinator.mjs";
import { installNavigationPolicy, isAllowedExternalUrl, isLocalAppUrl } from "./navigation-policy.mjs";
import { TrayManager } from "./tray-manager.mjs";
import { WindowManager } from "./window-manager.mjs";

const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(DESKTOP_DIR);
const config = resolveDesktopConfig({ app, root: ROOT });
app.setPath("userData", config.userDataDir);
app.setName("超级宝蛋");

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.exit(0);

const backend = new BackendManager(config);
let windows = null;
let tray = null;
let terminating = false;
const exitCoordinator = new ExitCoordinator({
  begin: (details) => { if (details.silent) terminating = true; },
  getPageState: () => windows?.pageCloseState() || { unsaved: false, busy: false, reasons: [] },
  confirmExit,
  stopBackend: (details) => backend.stop(details.silent ? 10_000 : undefined),
  decideTimeout,
  forceStop: () => backend.forceStop(),
  setStatus: (status) => windows?.sendBackendStatus(status),
  forceFailed: showForceFailure,
  finish: finishExit,
});

app.on("second-instance", restoreWindow);
app.on("activate", restoreWindow);
app.on("window-all-closed", () => { if (!terminating) void requestExit({ source: "application", silent: true }); });
app.on("before-quit", (event) => {
  if (terminating) return;
  event.preventDefault();
  void requestExit({ source: "application", silent: true });
});

backend.on("exit", ({ expected, code, signal }) => {
  if (expected || terminating) return;
  const detail = `后台服务意外退出（代码 ${code ?? "未知"}${signal ? `，信号 ${signal}` : ""}）`;
  if (windows?.businessLoaded) windows.sendBackendStatus({ state: "disconnected", message: `${detail}，当前页面已保留。` });
  else void windows?.showStartup({ state: "error", message: `${detail}，可以重试。` });
});
backend.on("log-error", () => windows?.sendBackendStatus({ state: "log-error", message: "日志写入失败，请检查磁盘空间或目录权限。" }));

if (hasLock) app.whenReady().then(initialize).catch((error) => {
  console.error(error);
  app.exit(1);
});

async function initialize() {
  registerIpc();
  windows = new WindowManager({
    stateFile: path.join(config.desktopRoot, "window-state.json"),
    preloadFile: path.join(DESKTOP_DIR, "preload.cjs"),
    startupFile: path.join(DESKTOP_DIR, "startup.html"),
    iconFile: path.join(ROOT, "public", "baodan.ico"),
    onCloseRequested: requestExit,
    onSessionEnd: () => void requestExit({ source: "session-end", silent: true }),
  });
  const window = await windows.create();
  installNavigationPolicy({
    window,
    baseUrl: backend.baseUrl,
    startupUrl: windows.startupUrl,
    openExternal: (url) => shell.openExternal(url),
    onError: (message) => windows.sendBackendStatus({ state: "navigation-error", message }),
  });
  tray = new TrayManager({
    iconFile: path.join(ROOT, "public", "baodan.ico"),
    createTray: (icon) => new Tray(icon),
    buildMenu: (template) => Menu.buildFromTemplate(template),
    showWindow: restoreWindow,
    requestExit: () => requestExit({ source: "tray", silent: true }),
    onError: (error) => void backend.logDesktopError(`托盘操作失败：${error?.message || error}`),
  });
  if (tray.create()) windows.enableCloseToTray();
  else await backend.logDesktopError("托盘创建失败，关闭窗口时将保留退出确认流程。");
  await startBackend();
}

async function startBackend() {
  if (terminating || backend.state === "stopping") return { ok: false };
  if (!windows.businessLoaded) await windows.showStartup({ state: "starting", message: "正在启动后台服务……" });
  else windows.sendBackendStatus({ state: "restarting", message: "正在重新连接后台服务……" });
  try {
    await backend.start();
    if (terminating) return { ok: false };
    if (!windows.businessLoaded) await windows.loadApplication(backend.baseUrl);
    else windows.sendBackendStatus({ state: "connected", message: "后台服务已恢复" });
    return { ok: true };
  } catch (error) {
    if (isStartCancelled(error)) return { ok: false, cancelled: true };
    const message = error?.code === "PORT_IN_USE" ? error.message : `启动失败：${error?.message || error}`;
    if (windows.businessLoaded) windows.sendBackendStatus({ state: "disconnected", message });
    else await windows.showStartup({ state: "error", message });
    return { ok: false, error: message };
  }
}

function requestExit(details = {}) { return exitCoordinator.request(details); }

function restoreWindow() {
  if (terminating) return false;
  return windows?.focus() || false;
}

async function confirmExit(state) {
  const reasons = state.reasons.length ? state.reasons : [state.busy ? "后台任务仍在执行" : "退出后将关闭超级宝蛋后台服务"];
  const confirmation = await showMessage({
    type: state.unsaved || state.busy || state.unknown ? "warning" : "question",
    title: "退出超级宝蛋",
    message: state.unknown ? "无法确认页面保存状态，仍要退出吗？" : "确定退出超级宝蛋吗？",
    detail: `${reasons.map((reason) => `• ${reason}`).join("\n")}\n\n已打开的 Word、Excel 和浏览器不会关闭。`,
    buttons: ["取消", "退出"], defaultId: 0, cancelId: 0, noLink: true,
  });
  return confirmation.response === 1;
}

async function decideTimeout() {
  const decision = await showMessage({
    type: "warning", title: "后台服务尚未退出", message: "后台服务未能在限定时间内正常退出。",
    detail: "可以继续等待，或只强制结束本次创建的超级宝蛋后台进程。已打开的办公软件不会关闭。",
    buttons: ["继续等待", "强制退出"], defaultId: 0, cancelId: 0, noLink: true,
  });
  return decision.response === 1 ? "force" : "wait";
}

async function showForceFailure(details = {}) {
  await backend.logDesktopError("后台进程未能在退出期限内停止，应用未记录为正常退出。");
  terminating = false;
  windows?.sendBackendStatus({ state: "disconnected", message: "后台进程未能退出。" });
  if (!details.silent) await showMessage({ type: "error", title: "无法强制退出", message: "后台进程仍在运行。请查看日志后重试。", buttons: ["确定"] });
}

async function finishExit() {
  await windows?.saveState();
  terminating = true;
  windows?.disableCloseToTray();
  windows?.permitClose();
  tray?.destroy();
  app.quit();
}

function showMessage(options) {
  return windows?.window ? dialog.showMessageBox(windows.window, options) : dialog.showMessageBox(options);
}

function registerIpc() {
  ipcMain.handle("desktop:request-exit", async (event) => {
    assertTrustedSender(event);
    return requestExit({ source: "page", silent: true });
  });
  ipcMain.handle("desktop:retry-startup", async (event) => {
    assertTrustedSender(event);
    return startBackend();
  });
  ipcMain.handle("desktop:open-logs", async (event) => {
    assertTrustedSender(event);
    await mkdir(backend.logDir, { recursive: true });
    const error = await shell.openPath(backend.logDir);
    return { ok: !error, error: error || backend.logError?.message || null };
  });
  ipcMain.handle("desktop:open-external", async (event, url) => {
    assertTrustedSender(event);
    if (!isAllowedExternalUrl(url)) throw new Error("不允许打开该链接");
    await shell.openExternal(url);
    return { ok: true };
  });
}

function assertTrustedSender(event) {
  const window = windows?.window;
  if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("拒绝未知窗口请求");
  const url = event.senderFrame.url;
  if (url !== windows.startupUrl && !isLocalAppUrl(url, backend.baseUrl)) throw new Error("拒绝未知页面请求");
}
