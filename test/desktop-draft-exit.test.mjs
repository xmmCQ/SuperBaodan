import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempProject } from './helpers/temp-project.mjs';
import { listenOnSafePort } from './helpers/listen.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const electron = path.join(root, 'node_modules/electron/dist/electron.exe');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Actual Electron regression: a renderer beforeunload veto must not strand a
// window after the explicit exit flow has already stopped its service and tray.
test('Windows桌面：未保存文档草稿不能阻止应用静默退出', { timeout: 45000 }, async t => {
  if (process.platform !== 'win32' || !existsSync(electron)) return t.skip('需要Windows Electron');
  const temp = await createTempProject('sb-draft-exit-');
  const probe = net.createServer(); const port = await listenOnSafePort(probe);
  await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, LOCALAPPDATA: temp.root };
  delete env.ELECTRON_RUN_AS_NODE; delete env.SUPER_BAODAN_DESKTOP_USE_EXISTING_CONFIG;
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], { cwd: root, env, stdio: 'ignore', windowsHide: true });
  const exited = new Promise(resolve => { child.once('exit', code => resolve({ code })); child.once('error', error => resolve({ error })); });
  let socket;
  t.after(async () => {
    socket?.close();
    if (child.exitCode == null && child.signalCode == null) {
      child.kill(); await Promise.race([exited, wait(2000)]);
      // The service's parent-disconnect cleanup has a 5s bound.
      await wait(5500);
    }
    await temp.cleanup();
  });
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })).json();
      page = pages.find(item => item.type === 'page' && item.url === 'app://workbench/');
    } catch {}
    if (!page) await wait(100);
  }
  assert.ok(page, '应用应加载本地首页');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const prepared = new Promise(resolve => {
    socket.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id === 1) resolve(message); };
  });
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true, expression: `(async()=>{
    for(let i=0;i<100&&!document.getElementById('workDocumentsDialog');i++)await new Promise(r=>setTimeout(r,30));
    workDocumentsButton.click();
    for(let i=0;i<100;i++){if(document.querySelector('.wd-toolbar .wd-primary')?.disabled===false)break;await new Promise(r=>setTimeout(r,30));}
    document.querySelector('.wd-toolbar .wd-primary').click();
    document.querySelector('.wd-editor [aria-label=文档名称]').value='未提交的隔离测试草稿';
    return !!document.querySelector('.wd-editor[open]');
  })()` } }));
  const preparation = await Promise.race([prepared, wait(7000).then(() => null)]);
  assert.equal(preparation?.result?.result?.value, true, JSON.stringify(preparation));
  socket.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'window.workbench.requestExit()' } }));
  // 退出协议允许正常清理10秒，再对自有进程进行有界强制结束。
  // 7秒早于协议上限，会把合法的SDK清理误判为草稿拦截。
  const result = await Promise.race([exited, wait(18000).then(() => null)]);
  assert.deepEqual(result, { code: 0 }, '应用必须完成退出，不能被草稿卸载保护卡住');
  assert.equal(existsSync(path.join(temp.root, 'SuperBaodan/desktop-dev/runtime/work-documents.json')), false, '退出不得自动保存草稿');
});
