import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sb-service-'));
  await mkdir(path.join(root, 'pi-agent'));
  await writeFile(path.join(root, 'work-todo.md'), '# 工作待办\n');
  const runId = 'isolated-service-test';
  const child = fork(fileURLToPath(new URL('../app/services/main.mjs', import.meta.url)), [], {
    silent: true, execArgv: [], serialization: 'advanced',
    env: { ...process.env, SUPER_BAODAN_DESKTOP_RUN_ID: runId, SUPER_BAODAN_DATA_DIR: root, PI_CODING_AGENT_DIR: path.join(root, 'pi-agent') },
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode == null) child.kill(); await exited; await rm(root, { recursive: true, force: true }); });
  child.stdout.resume(); child.stderr.resume();
  await message(child, m => m.type === 'ready');
  let sequence = 0;
  const invoke = async (name, args = {}) => {
    const id = String(++sequence); const result = message(child, m => m.type === 'result' && m.id === id);
    child.send({ type: 'invoke', runId, id, name, args }); return result;
  };
  return { child, invoke, runId, exited };
}
function message(child, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', handler); reject(new Error('IPC响应超时')); }, 8000);
    const handler = value => { if (predicate(value)) { clearTimeout(timer); child.off('message', handler); resolve(value); } };
    child.on('message', handler);
  });
}

test('独立业务进程通过IPC就绪、命令调用及正常退出', { timeout: 20000 }, async t => {
  const { child, invoke, runId, exited } = await fixture(t);
  assert.equal((await invoke('system.status')).value.ok, true);
  assert.equal((await invoke('not.authorized')).error.code, 404);
  const workspaceId = (await invoke('workspaces.list')).value.activeWorkspaceId;
  const upload = await invoke('files.upload', { workspaceId, name: 'test.png', content: Buffer.from('隔离文件'), overwrite: false });
  assert.equal(upload.error, undefined);
  const content = await invoke('files.content', { workspaceId, path: 'test.png' });
  assert.equal(Buffer.from(content.value.content).toString(), '隔离文件');
  assert.equal((await invoke('files.content', { workspaceId: 'stale', path: 'test.png' })).error.code, 409);
  assert.ok((await invoke('files.content', { workspaceId, path: '../work-todo.md' })).error);
  child.send({ type: 'shutdown', runId: 'wrong' });
  assert.equal((await invoke('system.status')).value.ok, true);
  child.send({ type: 'shutdown', runId });
  assert.equal(await exited, 0);
});

test('父进程IPC断开时业务进程自动退出', { timeout: 20000 }, async t => {
  const { child, exited } = await fixture(t); child.disconnect(); assert.equal(await exited, 0);
});
