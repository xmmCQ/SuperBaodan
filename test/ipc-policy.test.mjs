import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTrustedFrame, validateInvocation } from '../app/main/ipc-policy.mjs';
import { createResourceHandler, isAppUrl } from '../app/main/resources.mjs';
import { createEventChannel } from '../app/services/event-channel.mjs';
import { FileActions } from '../app/main/file-actions.mjs';
import { fileURLToPath } from 'node:url';

test('IPC拒绝未知命令、子框架、外部页面和过大消息', () => {
  const frame = { url: 'app://workbench/' }, contents = { mainFrame: frame }, window = { webContents: contents };
  assert.doesNotThrow(() => assertTrustedFrame({ sender: contents, senderFrame: frame }, window));
  assert.throws(() => assertTrustedFrame({ sender: contents, senderFrame: { url: frame.url } }, window), { statusCode: 403 });
  frame.url = 'https://evil.test'; assert.throws(() => assertTrustedFrame({ sender: contents, senderFrame: frame }, window), { statusCode: 403 });
  assert.throws(() => validateInvocation({ id: '1', name: 'exec', args: {} }));
  assert.throws(() => validateInvocation({ id: '1', name: 'system.status', args: { data: 'x'.repeat(1048576) } }), { statusCode: 413 });
  assert.throws(() => validateInvocation({ id: '1', name: 'files.upload', args: { content: [] } }), { statusCode: 400 });
  assert.deepEqual(validateInvocation({ id: '1', name: 'system.status', args: {} }), {});
});
test('资源协议拒绝外部主机和路径越界，不暴露服务代码或配置', async () => {
  const handler = createResourceHandler({ root: fileURLToPath(new URL('../', import.meta.url)), service: { invoke() { throw new Error('blocked'); } } });
  assert.equal(isAppUrl('file:///C:/secret'), false);
  for (const url of ['app://evil/index.html', 'app://workbench/%2e%2e%2fservices/main.mjs', 'app://workbench/%2e%2e%2f%2e%2e%2fpackage.json']) assert.notEqual((await handler({ url, method: 'GET' })).status, 200);
  const home = await handler({ url: 'app://workbench/', method: 'GET' }); assert.equal(home.status, 200);
  assert.match(home.headers.get('Content-Security-Policy'), /script-src 'self'/);
});
test('事件IPC背压有界，积压标记需要快照且关闭后不再发送', () => {
  const sent = [], callbacks = [];
  const channel = createEventChannel((event, done) => { sent.push(event); callbacks.push(done); }, { maxQueued: 4 });
  for (let i = 0; i < 50; i++) channel.push('agent', { type: 'message_update', i });
  assert.ok(channel.queued() <= 4); callbacks.shift()();
  assert.equal(sent[1].event.snapshotRequired, true);
  channel.close(); const count = sent.length; callbacks.shift()(); channel.push('agent', {}); assert.equal(sent.length, count);
});
test('原生文件对话框取消、重复调用及关闭后返回值受控', async () => {
  let done; const action = new FileActions({ dialog: { showOpenDialog: () => new Promise(resolve => { done = resolve; }) }, getWindow: () => ({}) });
  const first = action.pick(); await assert.rejects(action.pick(), { statusCode: 409 });
  done({ canceled: true }); assert.deepEqual(await first, { cancelled: true });
  const abort = new AbortController(); abort.abort(); await assert.rejects(action.pick(abort.signal), { statusCode: 499 });
});
