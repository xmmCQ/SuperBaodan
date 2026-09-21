import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempProject } from './helpers/temp-project.mjs';
import { listenOnSafePort } from './helpers/listen.mjs';
import { parseWorkTodo } from '../app/services/domain/tasks.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const electron = path.join(root, 'node_modules/electron/dist/electron.exe');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms, fallback = null) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })]); }
  finally { clearTimeout(timer); }
}

test('真实Electron：持续工作空入口、原生列表返回、IPC保存与重启保留', { timeout: 90000 }, async t => {
  if (process.platform !== 'win32' || !existsSync(electron)) return t.skip('需要Windows Electron');
  const temp = await createTempProject('sb-longterm-desktop-');
  const todoFile = await temp.write('SuperBaodan/desktop-dev/runtime/work-todo.md', '# 工作待办\n');
  const runs = [];
  t.after(async () => {
    for (const run of runs) {
      run.socket?.close();
      if (run.child.exitCode == null && run.child.signalCode == null) { run.child.kill(); await bounded(run.exited, 2000); await wait(5500); }
    }
    await temp.cleanup();
  });
  async function launch() {
    const probe = net.createServer(), port = await listenOnSafePort(probe); await new Promise(r => probe.close(r));
    const env = { ...process.env, LOCALAPPDATA: temp.root, USERPROFILE: temp.root };
    delete env.ELECTRON_RUN_AS_NODE; delete env.SUPER_BAODAN_DESKTOP_USE_EXISTING_CONFIG;
    const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], { cwd: root, env, stdio: 'ignore', windowsHide: true });
    const run = { child, exited: new Promise(resolve => { child.once('exit', code => resolve(code)); child.once('error', resolve); }) }; runs.push(run);
    let page;
    for (let i = 0; i < 150 && !page; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })).json()).find(p => p.type === 'page' && p.url === 'app://workbench/'); } catch {}
      if (!page) await wait(100);
    }
    assert.ok(page, '首页必须使用app://而非产品HTTP服务');
    const socket = run.socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0; const pending = new Map();
    socket.onmessage = ({ data }) => { const message = JSON.parse(data); pending.get(message.id)?.(message); pending.delete(message.id); };
    run.evaluate = async expression => {
      const id = ++sequence;
      const response = new Promise(resolve => pending.set(id, resolve));
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      const reply = await bounded(response, 8000);
      assert.ok(reply && !reply.error && !reply.result?.exceptionDetails, JSON.stringify(reply));
      return reply.result.result.value;
    };
    run.until = async expression => {
      for (let i = 0; i < 120; i++) { if (await run.evaluate(expression)) return; await wait(100); }
      assert.fail(`等待页面超时：${expression}`);
    };
    run.exit = async () => {
      await run.evaluate('window.workbench.requestExit(); true');
      assert.equal(await bounded(run.exited, 18000, 'timeout'), 0);
      socket.close();
    };
    await run.until("document.documentElement?.classList.contains('app-ready') && !!document.getElementById('newLongtermTaskButton')");
    return run;
  }
  const first = await launch();
  assert.equal(await first.evaluate("!openLongtermTasks.classList.contains('hidden') && longtermCount.textContent === '0'"), true);
  await first.evaluate('openLongtermTasks.click(); newLongtermTaskButton.click()');
  assert.equal(await first.evaluate("!taskSummaryDialog.open && taskStartDate.value === '' && taskEndDate.value === '' && taskRecurrence.value === ''"), true);
  await first.evaluate('taskStartDate.click()');
  assert.equal(await first.evaluate("!taskDatePicker.classList.contains('hidden') && taskStartDate.value === ''"), true);
  await first.evaluate("datePickerClear.click(); cancelTaskButton.click()");
  assert.equal(await first.evaluate('taskSummaryDialog.open && document.activeElement === newLongtermTaskButton'), true);
  await first.evaluate("newLongtermTaskButton.click(); taskText.value='隔离持续事项'; taskForm.requestSubmit(); taskForm.requestSubmit()");
  await first.until("taskSummaryDialog.open && longtermCount.textContent === '1' && longtermTasks.innerText.includes('隔离持续事项')");
  const saved = parseWorkTodo(await readFile(todoFile, 'utf8'));
  assert.equal(saved.length, 1); assert.equal(saved[0].kind, 'longterm'); assert.equal(saved[0].startDate, null); assert.equal(saved[0].endDate, null); assert.equal(saved[0].recurrence, null);
  await first.exit();
  const second = await launch();
  await second.until("longtermCount.textContent === '1'");
  await second.evaluate('openLongtermTasks.click()');
  assert.equal(await second.evaluate("longtermTasks.innerText.includes('隔离持续事项')"), true);
  await second.evaluate("longtermTasks.querySelector('[data-action=edit]').click(); taskStartDate.value='2026-09-01'; taskEndDate.value='2026-12-31'; taskRecurrence.value='week'; taskForm.requestSubmit()");
  await second.until("taskSummaryDialog.open && longtermTasks.innerText.includes('终止 2026-12-31')");
  await second.evaluate("longtermTasks.querySelector('[data-action=edit]').click(); taskStartDate.value=''; taskEndDate.value=''; taskRecurrence.value=''; taskForm.requestSubmit()");
  await second.until("taskSummaryDialog.open && !longtermTasks.innerText.includes('2026-12-31')");
  assert.equal(parseWorkTodo(await readFile(todoFile, 'utf8'))[0].kind, 'longterm');
  await second.evaluate("longtermTasks.querySelector('[data-action=delete]').click()");
  await second.until("longtermCount.textContent === '0' && longtermTasks.innerText.includes('暂无持续工作')");
  assert.equal(await second.evaluate("!openLongtermTasks.classList.contains('hidden') && !newLongtermTaskButton.classList.contains('hidden')"), true);
  await second.exit();
});
