import assert from "node:assert/strict";
import test from "node:test";
import { createBackendEnvironment, resolveDesktopConfig } from "../desktop/config.mjs";
import { ExitCoordinator } from "../desktop/exit-coordinator.mjs";
import { normalizeWindowState } from "../desktop/window-state.mjs";

function app(packaged = false) { return { isPackaged: packaged, getPath: () => "C:\\Users\\test\\AppData\\Roaming" }; }

test("运行配置隔离开发数据并明确正式目录", () => {
  const dev = resolveDesktopConfig({ app: app(false), root: "C:\\app", env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" } });
  assert.equal(dev.port, 3213); assert.match(dev.dataRoot, /desktop-dev\\runtime$/); assert.match(dev.userDataDir, /desktop-dev$/);
  const production = resolveDesktopConfig({ app: app(true), root: "C:\\app", env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" } });
  assert.equal(production.port, 3212); assert.match(production.dataRoot, /SuperBaodan$/); assert.match(production.userDataDir, /SuperBaodan\\desktop$/);
  assert.throws(() => resolveDesktopConfig({ app: app(), root: "C:\\app", env: { LOCALAPPDATA: "C:\\data", SUPER_BAODAN_DESKTOP_PORT: "80" } }), /端口/);
});

test("子进程环境清除冲突配置并设置受控运行标识", () => {
  const config = resolveDesktopConfig({ app: app(false), root: "C:\\app", env: { LOCALAPPDATA: "C:\\data" } });
  const env = createBackendEnvironment(config, "run-1", { SUPER_BAODAN_PORT: "9999", SUPER_BAODAN_DESKTOP_OWNER_ID: "old", PATH: "ok" });
  assert.equal(env.SUPER_BAODAN_PORT, "3213"); assert.equal(env.SUPER_BAODAN_DESKTOP_RUN_ID, "run-1");
  assert.equal(env.SUPER_BAODAN_DESKTOP_CONTROLLED, "1"); assert.equal(env.SUPER_BAODAN_DESKTOP_OWNER_ID, undefined); assert.equal(env.PATH, "ok");
});

test("小屏幕窗口最小尺寸不超过工作区", () => {
  const display = { workArea: { x: 0, y: 0, width: 800, height: 500 } };
  const result = normalizeWindowState(null, [display], display);
  assert.equal(result.minimumWidth, 800); assert.equal(result.minimumHeight, 500);
  assert.deepEqual(result.bounds, { x: 0, y: 0, width: 800, height: 500 });
});

test("窗口按保存位置选择显示器并在显示器移除后回到可见区", () => {
  const primary = { workArea: { x: 0, y: 0, width: 1200, height: 800 } };
  const secondary = { workArea: { x: 1200, y: 0, width: 1600, height: 900 } };
  const saved = { bounds: { x: 1400, y: 100, width: 1300, height: 850 }, maximized: true };
  const onSecondary = normalizeWindowState(saved, [primary, secondary], primary).bounds;
  assert.deepEqual(onSecondary, { x: 1400, y: 50, width: 1300, height: 850 });
  const restored = normalizeWindowState(saved, [primary], primary);
  assert.ok(restored.bounds.x >= 0 && restored.bounds.x + restored.bounds.width <= 1200);
  assert.ok(restored.bounds.y >= 0 && restored.bounds.y + restored.bounds.height <= 800);
  assert.equal(normalizeWindowState({ bounds: { x: NaN, y: 0, width: -1, height: 2 } }, [primary], primary).maximized, false);
});

test("所有退出请求复用一个流程，取消时不停止服务", async () => {
  let release; const confirmation = new Promise((resolve) => { release = resolve; });
  let stops = 0, statuses = 0;
  const coordinator = new ExitCoordinator({
    getPageState: async () => ({ unsaved: true, busy: false, reasons: ["草稿"] }),
    confirmExit: () => confirmation,
    stopBackend: async () => { stops++; return true; }, decideTimeout: async () => "wait", forceStop: async () => true,
    setStatus: () => { statuses++; }, finish: async () => {},
  });
  const first = coordinator.request({ source: "window" }), second = coordinator.request({ source: "page" });
  assert.strictEqual(first, second); release(false);
  assert.deepEqual(await first, { ok: false, cancelled: true }); assert.equal(stops, 0); assert.equal(statuses, 0);
});

test("静默退出跳过页面状态和确认，超时后自动强制停止", async () => {
  const calls = [];
  let release; const stopping = new Promise((resolve) => { release = resolve; });
  const coordinator = new ExitCoordinator({
    begin: (details) => calls.push(`begin:${details.source}`),
    getPageState: async () => { throw new Error("不应读取页面状态"); },
    confirmExit: async () => { throw new Error("不应确认"); },
    stopBackend: async (details) => { calls.push(`stop:${details.silent}`); await stopping; return false; },
    decideTimeout: async () => { throw new Error("不应弹超时选择"); },
    forceStop: async () => { calls.push("force"); return true; },
    setStatus: () => calls.push("status"), finish: async () => calls.push("finish"),
  });
  const first = coordinator.request({ source: "tray", silent: true });
  const second = coordinator.request({ source: "tray", silent: true });
  assert.strictEqual(first, second); release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(calls, ["begin:tray", "status", "stop:true", "force", "finish"]);
});

test("静默退出强制停止失败只记录失败且不完成退出", async () => {
  let confirmed = 0, finished = 0, failed = 0;
  const coordinator = new ExitCoordinator({
    getPageState: async () => { confirmed++; return {}; }, confirmExit: async () => { confirmed++; return true; },
    stopBackend: async () => false, decideTimeout: async () => "wait", forceStop: async () => false,
    finish: async () => { finished++; }, forceFailed: async (details) => { assert.equal(details.silent, true); failed++; },
  });
  assert.deepEqual(await coordinator.request({ silent: true }), { ok: false, forceFailed: true });
  assert.equal(confirmed, 0); assert.equal(finished, 0); assert.equal(failed, 1);
});

test("退出超时后强制停止失败不会完成退出", async () => {
  let finished = 0, failed = 0;
  const coordinator = new ExitCoordinator({
    getPageState: async () => ({ unsaved: false, busy: true, reasons: ["任务"] }), confirmExit: async () => true,
    stopBackend: async () => false, decideTimeout: async () => "force", forceStop: async () => false,
    finish: async () => { finished++; }, forceFailed: async () => { failed++; },
  });
  assert.deepEqual(await coordinator.request(), { ok: false, forceFailed: true }); assert.equal(finished, 0); assert.equal(failed, 1);
});
