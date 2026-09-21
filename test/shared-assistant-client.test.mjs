import test from 'node:test';
import assert from 'node:assert/strict';
import { invoke, ApplicationError, workspacePayload, scopedResource } from '../app/renderer/core/service-client.js';
import { createAgentEventStream } from '../app/renderer/core/event-stream.js';
import { createAgentClient } from '../app/renderer/core/agent-client.js';
import { createSessionService } from '../app/renderer/core/session-service.js';

test('请求参数携带工作区，资源地址不包含文件绝对路径', () => {
  assert.deepEqual(workspacePayload({ type: 'prompt' }, 'w1'), { type: 'prompt', workspaceId: 'w1' });
  assert.equal(scopedResource('app://workbench/content?path=a.png', 'w1'), 'app://workbench/content?path=a.png&workspaceId=w1');
});
test('IPC错误码、超时及取消统一处理', async t => {
  const original = globalThis.window; t.after(() => { globalThis.window = original; });
  let cancelled = 0;
  globalThis.window = { workbench: { invoke: async () => ({ ok: false, error: { code: 409, message: '冲突' } }), cancel() { cancelled++; } } };
  await assert.rejects(invoke('records.save'), error => error instanceof ApplicationError && error.status === 409);
  window.workbench.invoke = () => new Promise(() => {});
  await assert.rejects(invoke('system.status', {}, { timeout: 5 }), /操作超时/);
  const abort = new AbortController(); const flight = invoke('system.status', {}, { signal: abort.signal }); abort.abort();
  await assert.rejects(flight, /操作已取消/); assert.equal(cancelled, 2);
});
test('事件通道只订阅一次，关闭后释放监听器', async () => {
  let event, status, released = 0; const received = [], states = [];
  const bridge = { onEvent(fn) { event = fn; return () => { released++; }; }, onBackendStatus(fn) { status = fn; return () => { released++; }; } };
  const stream = createAgentEventStream({ bridge, request: async () => [], onEvent: e => received.push(e), onStatus: s => states.push(s) });
  assert.strictEqual(stream.connect(), stream.connect()); await new Promise(setImmediate);
  event({ topic: 'agent', event: { type: 'agent_start' } }); assert.equal(received[0].type, 'agent_start');
  status({ state: 'disconnected' }); stream.close(); assert.equal(released, 2);
  assert.deepEqual(states, ['connecting', 'open', 'reconnecting', 'closed']);
});
test('Agent事件统一更新忙碌和停止状态', () => {
  const client = createAgentClient({ request: async () => ({}) });
  assert.equal(client.applyEvent({ type: 'agent_start' }).running, true);
  assert.equal(client.applyEvent({ type: 'agent_settled' }).running, false);
});
test('会话命令始终携带工作区，保留顺序协调', async () => {
  const calls = [];
  const service = createSessionService({ getWorkspaceId: () => 'w1', agentClient: {}, request: async (name, args) => { calls.push([name,args]); return { sessions: [] }; } });
  await service.list(); await service.create(); await service.activate('a.jsonl'); await service.rename('a.jsonl','name'); await service.remove('a.jsonl');
  assert.deepEqual(calls.map(([n]) => n), ['sessions.list','agent.new','sessions.activate','sessions.rename','sessions.delete']);
  for (const [,args] of calls) assert.equal(args.workspaceId, 'w1');
});
