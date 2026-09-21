import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAgentEventStream } from '../app/renderer/core/event-stream.js';
import { createRuntimeContext } from '../app/services/runtime-context.mjs';
import { sdkHarness, deferred, wait } from './helpers/fake-sdk-host.mjs';

function streamFixture() {
  const requests = [], events = [], statuses = [];
  let listener, statusListener;
  const stream = createAgentEventStream({
    bridge: { onEvent(fn) { listener = fn; return () => {}; }, onBackendStatus(fn) { statusListener = fn; return () => {}; } },
    request() { const gate = deferred(); requests.push(gate); return gate.promise; },
    onEvent: event => events.push(event), onStatus: status => statuses.push(status),
  });
  return { stream, requests, events, statuses, emit: event => listener({ topic: 'agent', event }), status: value => statusListener(value) };
}

test('关闭后重建连接，旧初始化成功或失败均不能污染新连接', async () => {
  for (const failure of [false, true]) {
    const f = streamFixture(); f.stream.connect(); f.stream.close(); f.stream.connect();
    const count = f.statuses.length;
    if (failure) f.requests[0].reject(new Error('old error'));
    else f.requests[0].resolve([{ type: 'connected', workspace: { id: 'old' } }]);
    await wait(0); assert.equal(f.events.length, 0); assert.equal(f.statuses.length, count);
    f.requests[1].resolve([{ type: 'connected', workspace: { id: 'new' } }]);
    await wait(0); assert.equal(f.events[0].workspace.id, 'new'); f.stream.close();
  }
});

test('工作区变更或断线使在途连接快照失效', async () => {
  const f = streamFixture(); f.stream.connect();
  f.emit({ type: 'workspace_changed', workspace: { id: 'B' } });
  f.requests[0].resolve([{ type: 'connected', workspace: { id: 'A' } }]);
  await wait(0); assert.deepEqual(f.events.map(event => event.workspace.id), ['B']);
  f.status({ state: 'connected' }); f.status({ state: 'disconnected' });
  f.requests[1].resolve([{ type: 'connected', workspace: { id: 'old-run' } }]);
  await wait(0); assert.equal(f.events.length, 1);
  f.status({ state: 'connected' }); f.requests[2].resolve([{ type: 'connected', workspace: { id: 'C' } }]);
  await wait(0); assert.equal(f.events.at(-1).workspace.id, 'C'); f.stream.close();
});

test('退出先解除SDK启动弹窗，随后等待已提交写入完成', { timeout: 5000 }, async t => {
  let answer = 'pending';
  const h = await sdkHarness({ bind: async (_session, bindings) => { answer = await bindings.uiContext.editor('startup', 'draft'); } });
  const writeGate = deferred();
  t.after(async () => { writeGate.resolve(); await h.cleanup(); });
  const c = await createRuntimeContext({
    workspaceDir: h.temp.resolve('workspace'), piAgentDir: h.temp.resolve('agent'), piSessionDir: h.temp.resolve('sessions'),
    backupDir: h.temp.resolve('backups'), todoFile: h.temp.resolve('todo.md'),
    vskillFile: h.temp.resolve('vskills.json'), dailyRecordFile: h.temp.resolve('records.json'), workspaceFile: h.temp.resolve('workspaces.json'),
  });
  await c.piRuntime.close(); c.piRuntime = h.runtime;
  t.after(() => c.piAdmin.close());
  const starting = h.runtime.ensureStarted(); starting.catch(() => {});
  for (let i = 0; i < 100 && !h.runtime.pendingUiRequests().length; i++) await wait(5);
  assert.equal(h.runtime.pendingUiRequests().length, 1);
  const controller = new AbortController();
  const writing = writeGate.promise.then(() => h.temp.write('accepted-write.txt', '已提交内容'));
  let finished = false;
  const shutdown = c.shutdown([{ task: starting, controller }, { task: writing }]).then(() => { finished = true; });
  await wait(20);
  assert.equal(controller.signal.aborted, true); assert.equal(answer, undefined);
  assert.equal(h.runtime.pendingUiRequests().length, 0); assert.equal(finished, false);
  writeGate.resolve(); await shutdown;
  assert.equal(await readFile(h.temp.resolve('accepted-write.txt'), 'utf8'), '已提交内容');
  assert.equal(h.runtime.closed, true);
});
