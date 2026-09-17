import { app, dialog, ipcMain, Menu, protocol, shell, Tray } from 'electron';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendManager, isStartCancelled } from './backend-manager.mjs';
import { FileActions } from './file-actions.mjs';
import { ServiceClient } from './service-client.mjs';
import { resolveDesktopConfig } from './config.mjs';
import { ExitCoordinator } from './exit-coordinator.mjs';
import { installNavigationPolicy, isAllowedExternalUrl } from './navigation-policy.mjs';
import { APP_ORIGIN, createResourceHandler, isAppUrl } from './resources.mjs';
import { TrayManager } from './tray-manager.mjs';
import { WindowManager } from './window-manager.mjs';
import { assertTrustedFrame, validateInvocation } from './ipc-policy.mjs';
import { MAX_PENDING_REQUESTS } from '../shared/commands.js';
import { fault, publicErrorMessage } from '../shared/errors.js';

const MAIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MAIN_DIR, '../..');
const config = resolveDesktopConfig({ app, root: ROOT });
app.setPath('userData', config.userDataDir);
app.setName('超级宝蛋');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.exit(0);

const backend = new BackendManager(config);
const service = new ServiceClient(backend);
let windows, tray, terminating = false, quitPermitted = false;
const requests = new Map();
const openingDocuments = new Set();
const files = new FileActions({ dialog, getWindow: () => windows.window });
const exitCoordinator = new ExitCoordinator({
  begin: () => { terminating = true; },
  stopBackend: () => backend.stop(10000),
  forceStop: () => backend.forceStop(),
  setStatus: status => windows?.sendBackendStatus(status),
  forceFailed: async () => {
    await backend.logDesktopError('未能确认应用服务退出，保留托盘以便重试。');
    terminating = false;
    windows?.sendBackendStatus({ state: 'disconnected', message: '应用服务未能退出，请重试。' });
  },
  finish: async () => {
    await windows?.saveState();
    windows?.permitClose();
    tray?.destroy();
    quitPermitted = true;
    app.quit();
  },
});

function requestExit() { terminating = true; return exitCoordinator.request(); }
function restoreWindow() { if (!terminating) windows?.focus(); }
app.on('second-instance', restoreWindow);
app.on('activate', restoreWindow);
app.on('window-all-closed', () => { if (!terminating) void requestExit(); });
app.on('before-quit', event => { if (!hasLock || quitPermitted) return; event.preventDefault(); void requestExit(); });
backend.on('exit', ({ expected }) => {
  for (const request of requests.values()) request.abort();
  if (expected || terminating) return;
  if (windows?.businessLoaded) windows.sendBackendStatus({ state: 'disconnected', message: '应用服务已断开，当前页面已保留。' });
  else void windows?.showStartup({ state: 'error', message: '应用服务启动失败，可以重试。' });
});
backend.on('log-error', () => windows?.sendBackendStatus({ state: 'log-error', message: '日志写入失败，请检查磁盘。' }));
service.on('event', ({ topic, event }) => {
  if (!terminating && windows?.window && !windows.window.webContents.isDestroyed()) windows.window.webContents.send('workbench:event', { topic, event });
});

if (hasLock) app.whenReady().then(initialize).catch(async error => {
  await backend.logDesktopError(publicErrorMessage(error));
  await backend.forceStop(); tray?.destroy(); app.exit(1);
});

async function initialize() {
  protocol.handle('app', createResourceHandler({ root: ROOT, service }));
  windows = new WindowManager({
    stateFile: path.join(config.desktopRoot, 'window-state.json'),
    preloadFile: path.join(ROOT, 'app/preload/index.cjs'),
    startupFile: path.join(MAIN_DIR, 'startup.html'),
    iconFile: path.join(ROOT, 'app/renderer/baodan.ico'),
    onCloseRequested: requestExit, onSessionEnd: requestExit,
  });
  registerIpc();
  const window = await windows.create();
  if (terminating) return;
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) for (const request of requests.values()) request.abort();
  });
  installNavigationPolicy({ window, baseUrl: APP_ORIGIN, startupUrl: windows.startupUrl, openExternal: url => shell.openExternal(url), onError: message => windows.sendBackendStatus({ state: 'navigation-error', message }) });
  tray = new TrayManager({
    iconFile: path.join(ROOT, 'app/renderer/baodan.ico'), createTray: icon => new Tray(icon),
    buildMenu: template => Menu.buildFromTemplate(template), showWindow: restoreWindow, requestExit,
    onError: error => void backend.logDesktopError(publicErrorMessage(error)),
  });
  if (tray.create()) windows.enableCloseToTray();
  await startBackend();
}

async function startBackend() {
  if (terminating || backend.state === 'stopping') return { ok: false };
  if (!windows.businessLoaded) await windows.showStartup({ state: 'starting', message: '正在准备工作台……' });
  else windows.sendBackendStatus({ state: 'restarting', message: '正在恢复应用服务……' });
  try {
    if (terminating) return { ok: false };
    await backend.start();
    if (terminating) return { ok: false };
    if (!windows.businessLoaded) await windows.loadApplication(APP_ORIGIN + '/');
    else windows.sendBackendStatus({ state: 'connected' });
    return { ok: true };
  } catch (error) {
    if (terminating || isStartCancelled(error)) return { ok: false };
    const status = { state: windows.businessLoaded ? 'disconnected' : 'error', message: publicErrorMessage(error) };
    if (windows.businessLoaded) windows.sendBackendStatus(status); else await windows.showStartup(status);
    return { ok: false, error: status.message };
  }
}

function assertTrustedSender(event) { assertTrustedFrame(event, windows?.window, windows?.startupUrl); }

function registerIpc() {
  ipcMain.handle('workbench:invoke', async (event, message) => {
    let id, openingId;
    try {
      assertTrustedSender(event);
      if (terminating) throw fault(503, '工作台正在退出');
      const args = validateInvocation(message);
      if (requests.has(message.id) || requests.size >= MAX_PENDING_REQUESTS) throw fault(429, '操作繁忙');
      id = message.id;
      const controller = new AbortController(); requests.set(id, controller);
      let value;
      if (message.name === 'documents.pick') {
        value = await files.pick(controller.signal);
      } else {
        if (message.name === 'documents.open') {
          if (typeof args.id !== 'string' || !args.id) throw fault(400, '缺少文档标识');
          if (openingDocuments.has(args.id)) throw fault(409, '正在打开文档');
          openingId = args.id; openingDocuments.add(openingId);
        }
        value = await service.invoke(message.name, args, { signal: controller.signal });
        if (message.name === 'documents.open') {
          if (terminating || controller.signal.aborted) throw fault(499, '已取消打开文档');
          const error = await shell.openPath(value.path);
          if (error) throw fault(502, '无法打开该文档');
          value = { ok: true, opened: true, message: '已交给系统打开' };
        }
      }
      return { ok: true, value };
    } catch (error) { return { ok: false, error: { code: error.statusCode || 500, message: publicErrorMessage(error) } }; }
    finally { if (id) requests.delete(id); if (openingId) openingDocuments.delete(openingId); }
  });
  ipcMain.on('workbench:cancel', (event, id) => { try { assertTrustedSender(event); requests.get(id)?.abort(); } catch {} });
  ipcMain.handle('workbench:exit', event => { assertTrustedSender(event); return requestExit(); });
  ipcMain.handle('workbench:retry', event => { assertTrustedSender(event); return startBackend(); });
  ipcMain.handle('workbench:logs', async event => { assertTrustedSender(event); await mkdir(backend.logDir, { recursive: true }); const error = await shell.openPath(backend.logDir); return { ok: !error, error }; });
  ipcMain.handle('workbench:external', async (event, url) => { assertTrustedSender(event); if (terminating || !isAllowedExternalUrl(url)) throw fault(403, '不允许打开该链接'); await shell.openExternal(url); return { ok: true }; });
}
