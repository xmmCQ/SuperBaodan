import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isAllowedExternalUrl, isLocalAppUrl } from '../app/main/navigation-policy.mjs';
const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('入口只启动Electron并固定版本', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.scripts.start, 'electron .'); assert.equal(pkg.scripts.server, undefined);
  assert.equal(pkg.main, 'app/main/main.mjs'); assert.equal(pkg.devDependencies.electron, '44.1.1');
});
test('服务进程拒绝独立启动', () => {
  const env = { ...process.env }; delete env.SUPER_BAODAN_DESKTOP_RUN_ID;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../app/services/main.mjs', import.meta.url))], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /只能由主进程启动/);
});
test('预加载不开放Node或任意IPC通道', async () => {
  const preload = await read('app/preload/index.cjs');
  assert.match(preload, /workbench:invoke/); assert.doesNotMatch(preload, /ipcRenderer\s*:/);
  const window = await read('app/main/window-manager.mjs');
  for (const setting of ['contextIsolation: true', 'sandbox: true', 'nodeIntegration: false', 'webSecurity: true']) assert.ok(window.includes(setting));
});
test('导航仅允许应用协议，外链只允许安全协议', () => {
  assert.equal(isLocalAppUrl('app://workbench/assistant.html'), true);
  for (const url of ['app://other/', 'http://127.0.0.1:3213/', 'file:///C:/data', 'data:text/html,test']) assert.equal(isLocalAppUrl(url), false);
  assert.equal(isAllowedExternalUrl('https://example.com'), true);
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false);
});
test('OAuth走桌面外链接口，退出无需页面状态查询', async () => {
  assert.match(await read('app/renderer/assistant/auth-controller.js'), /workbench\?\.openExternal/);
  assert.doesNotMatch(await read('app/main/main.mjs'), /pageCloseState|confirmExit|showMessageBox/);
});
