import assert from "node:assert/strict";
import test from "node:test";
import { createBackendEnvironment, resolveDesktopConfig } from "../app/main/config.mjs";
import { ExitCoordinator } from "../app/main/exit-coordinator.mjs";
import { normalizeWindowState } from "../app/main/window-state.mjs";

function app(packaged = false) { return { isPackaged: packaged, getPath: () => "C:\\Users\\test\\AppData\\Roaming" }; }

test("运行配置隔离开发数据并明确正式目录", () => {
  const dev = resolveDesktopConfig({ app: app(false), root: "C:\\app", env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" } });
  assert.equal(dev.port, undefined); assert.match(dev.dataRoot, /desktop-dev\\runtime$/); assert.match(dev.userDataDir, /desktop-dev$/);
  const production = resolveDesktopConfig({ app: app(true), root: "C:\\app", env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" } });
  assert.equal(production.port, undefined); assert.match(production.dataRoot, /SuperBaodan$/); assert.match(production.userDataDir, /SuperBaodan\\desktop$/);
});

test("子进程环境清除冲突配置并设置受控运行标识", () => {
  const config = resolveDesktopConfig({ app: app(false), root: "C:\\app", env: { LOCALAPPDATA: "C:\\data" } });
  const env = createBackendEnvironment(config, "run-1", { SUPER_BAODAN_PORT: "9999", SUPER_BAODAN_DESKTOP_OWNER_ID: "old", PATH: "ok" });
  assert.equal(env.SUPER_BAODAN_PORT, undefined); assert.equal(env.SUPER_BAODAN_DESKTOP_RUN_ID, "run-1");
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

test("退出请求合并，正常停止后完成清理", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const coordinator = new ExitCoordinator({
    begin: () => calls.push("begin"),
    stopBackend: async () => { calls.push("stop"); await gate; return true; },
    forceStop: async () => { throw new Error("不应强制结束"); },
    finish: async () => calls.push("finish"),
  });
  const first = coordinator.request();
  assert.strictEqual(first, coordinator.request()); release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(calls, ["begin", "stop", "finish"]);
});

test("停止超时或抛错自动强制结束，强制失败不能报告成功", async () => {
  for (const throws of [false, true]) {
    for (const forceResult of [false, true]) {
      let failed = 0, finished = 0;
      const coordinator = new ExitCoordinator({
        stopBackend: async () => { if (throws) throw new Error("stop failed"); return false; },
        forceStop: async () => forceResult,
        forceFailed: async () => { failed++; },
        finish: async () => { finished++; },
      });
      assert.deepEqual(await coordinator.request(), forceResult ? { ok: true } : { ok: false, forceFailed: true });
      assert.equal(finished, Number(forceResult)); assert.equal(failed, Number(!forceResult));
    }
  }
});
