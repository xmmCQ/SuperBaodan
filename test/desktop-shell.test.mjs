import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isAllowedExternalUrl, isLocalAppUrl } from "../desktop/navigation-policy.mjs";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("desktop package pins Electron and keeps browser launcher", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(pkg.scripts.start, "node launcher.mjs");
  assert.equal(pkg.scripts["desktop:dev"], "electron .");
  assert.equal(pkg.devDependencies.electron, "44.1.1");
  assert.equal(pkg.main, "desktop/main.mjs");
});

test("BrowserWindow uses the required isolation settings", async () => {
  const source = await read("desktop/window-manager.mjs");
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /webSecurity:\s*true/);
});

test("preload exposes named capabilities without a generic IPC bridge", async () => {
  const source = await read("desktop/preload.cjs");
  assert.match(source, /requestExit/);
  assert.match(source, /openExternal/);
  assert.doesNotMatch(source, /ipcRenderer\s*:/);
  assert.doesNotMatch(source, /invoke:\s*ipcRenderer\.invoke/);
});

test("navigation helpers only accept the local app and safe external protocols", () => {
  const base = "http://127.0.0.1:3213";
  assert.equal(isLocalAppUrl("http://127.0.0.1:3213/assistant.html", base), true);
  assert.equal(isLocalAppUrl("http://localhost:3213/", base), false);
  assert.equal(isLocalAppUrl("http://127.0.0.1:9999/", base), false);
  assert.equal(isAllowedExternalUrl("https://example.com/login"), true);
  assert.equal(isAllowedExternalUrl("mailto:test@example.com"), true);
  assert.equal(isAllowedExternalUrl("file:///C:/Windows/System32/calc.exe"), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
});

test("窗口关闭转为托盘隐藏且恢复不重载页面", async () => {
  const windowManager = await read("desktop/window-manager.mjs");
  const main = await read("desktop/main.mjs");
  const bridge = await read("public/core/desktop-bridge.js");
  assert.match(windowManager, /if \(this\.closeToTray\)[\s\S]*window\.hide\(\)/);
  assert.match(windowManager, /isMinimized\(\)[\s\S]*restore\(\)[\s\S]*show\(\)[\s\S]*focus\(\)/);
  assert.match(main, /new TrayManager/); assert.match(main, /windows\.enableCloseToTray\(\)/);
  assert.match(main, /source: "tray", silent: true/);
  assert.match(bridge, /#exitWorkbenchButton, #exitWorkbench/);
});

test("desktop readiness carries per-launch identity", async () => {
  const server = await read("server.mjs");
  const routes = await read("server/routes/system.mjs");
  assert.match(server, /SUPER_BAODAN_DESKTOP_RUN_ID/);
  assert.match(server, /process\.once\("disconnect"/);
  assert.match(routes, /desktopInstanceId/);
  assert.match(routes, /desktopControlled/);
});
