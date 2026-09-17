import assert from "node:assert/strict";
import test from "node:test";
import { TrayManager } from "../desktop/tray-manager.mjs";

function harness({ fail = false } = {}) {
  const calls = { shown: 0, exited: 0, errors: [], destroyed: 0 };
  const nativeTray = {
    handlers: {}, setToolTip(value) { this.tooltip = value; }, setContextMenu(value) { this.menu = value; },
    on(event, handler) { this.handlers[event] = handler; }, destroy() { calls.destroyed++; },
  };
  const tray = new TrayManager({
    iconFile: "baodan.ico",
    createTray: () => { if (fail) throw new Error("icon failed"); return nativeTray; },
    buildMenu: (template) => template,
    showWindow: () => { calls.shown++; }, requestExit: () => { calls.exited++; },
    onError: (error) => calls.errors.push(error.message),
  });
  return { tray, nativeTray, calls };
}

test("托盘只创建一次并提供显示与退出菜单", () => {
  const { tray, nativeTray, calls } = harness();
  assert.equal(tray.create(), true); assert.equal(tray.create(), true);
  assert.equal(nativeTray.tooltip, "超级宝蛋");
  assert.deepEqual(nativeTray.menu.map((item) => item.label || item.type), ["显示窗口", "separator", "退出"]);
  nativeTray.handlers.click(); nativeTray.menu[0].click(); nativeTray.menu[2].click();
  assert.equal(calls.shown, 2); assert.equal(calls.exited, 1);
  tray.destroy(); tray.destroy(); assert.equal(calls.destroyed, 1);
});

test("托盘创建失败时返回失败并记录错误", () => {
  const { tray, calls } = harness({ fail: true });
  assert.equal(tray.create(), false); assert.deepEqual(calls.errors, ["icon failed"]); assert.equal(tray.tray, null);
});
