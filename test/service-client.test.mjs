import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ServiceClient } from '../app/main/service-client.mjs';

function fixture() {
  const backend = new EventEmitter(), sent = [];
  backend.state = 'running';
  backend.currentRun = { id: 'run-1', child: { connected: true, send(message, callback) { sent.push(message); callback?.(); } } };
  const client = new ServiceClient(backend);
  const reply = (message, value, run = backend.currentRun) => backend.emit('message', { run, message: { v:1,runId:run.id,name:message.name,type: 'result', id: message.id, value } });
  return { backend, sent, client, reply };
}
test('IPC并发响应按请求ID匹配，旧实例消息不能完成当前请求', async () => {
  const f = fixture();
  const first = f.client.invoke('system.status'), second = f.client.invoke('records.list');
  f.reply(f.sent[0], 'wrong', { id: 'old-run' });
  assert.equal(f.client.pending.size, 2);
  f.reply(f.sent[1], 'second'); f.reply(f.sent[0], 'first');
  assert.equal(await first, 'first'); assert.equal(await second, 'second'); assert.equal(f.client.pending.size, 0);
});
test('IPC取消与超时发送取消消息并释放等待者', async () => {
  const f = fixture(), controller = new AbortController();
  const flight = f.client.invoke('system.status', {}, { signal: controller.signal }); controller.abort();
  await assert.rejects(flight, { statusCode: 499 }); assert.equal(f.sent.at(-1).type, 'cancel');
  await assert.rejects(f.client.invoke('system.status', {}, { timeout: 5 }), { statusCode: 408 });
  assert.equal(f.client.pending.size, 0);
});
test('服务退出拒绝所有未完成请求，未知命令不进入子进程', async () => {
  const f = fixture();
  await assert.rejects(f.client.invoke('exec'), { statusCode: 403 }); assert.equal(f.sent.length, 0);
  const request = f.client.invoke('system.status'); f.backend.emit('exit', {});
  await assert.rejects(request, { statusCode: 503 }); assert.equal(f.client.pending.size, 0);
});
