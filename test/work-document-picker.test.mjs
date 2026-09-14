import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { WorkDocuments } from '../lib/work-documents.mjs';
import { pickWorkDocument, FILE_PICKER_SCRIPT } from '../lib/pick-work-document.mjs';
import { createTempProject } from './helpers/temp-project.mjs';
import { createServerApplication } from '../server/app.mjs';

test('原生选择器使用固定STA脚本、超时和信号，不接受动态脚本输入', async t => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  assert.match(FILE_PICKER_SCRIPT, /GetForegroundWindow/);
  assert.match(FILE_PICKER_SCRIPT, /IWin32Window/);
  assert.doesNotMatch(FILE_PICKER_SCRIPT, /\$owner\.(Opacity|Show|Activate|Dispose)/);
  let options;
  const result = await pickWorkDocument({}, async (command, args, opts) => {
    assert.ok(command.endsWith('powershell.exe')); assert.ok(args.includes('-STA'));
    assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), FILE_PICKER_SCRIPT);
    options = opts; return { stdout: '{"cancelled":true}' };
  });
  assert.equal(result.cancelled, true); assert.equal(options.windowsHide, true); assert.equal(options.timeout, 180000);
});
test('选择文件返回完整路径和名称；取消不写配置；危险类型拒绝', async t => {
  const temp = await createTempProject('work-picker-'); t.after(temp.cleanup);
  const file = temp.resolve('自定义 (资料).txt'); await fs.writeFile(file, 'fixture');
  const manager = new WorkDocuments({ filePath: temp.resolve('config.json'), pick: async () => ({ cancelled: false, path: file }) });
  const selected = await manager.chooseFile(); assert.equal(selected.path.toLowerCase(), file.toLowerCase()); assert.equal(selected.name, '自定义 (资料).txt');
  await assert.rejects(fs.stat(manager.filePath), { code: 'ENOENT' });
  manager.pick = async () => ({ cancelled: true }); assert.deepEqual(await manager.chooseFile(), { cancelled: true });
  manager.pick = async () => ({ cancelled: false, path: 'C:\\bad.exe' }); await assert.rejects(manager.chooseFile(), { statusCode: 400 });
});
test('只允许一个选择窗口，关闭/断开会取消，后续仍可继续选择', async t => {
  const temp = await createTempProject('work-picker-'); t.after(temp.cleanup);
  let signal;
  const manager = new WorkDocuments({ filePath: temp.resolve('config.json'), pick: options => { signal = options.signal; return new Promise(resolve => signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true })); } });
  const pending = manager.chooseFile(); await assert.rejects(manager.chooseFile(), { statusCode: 409 }); manager.cancelPicker();
  await assert.rejects(pending, { statusCode: 499 }); assert.equal(signal.aborted, true);
  const abort = new AbortController(), next = manager.chooseFile({ signal: abort.signal }); abort.abort(); await assert.rejects(next, { statusCode: 499 });
  manager.pick = async () => ({ cancelled: true }); assert.equal((await manager.chooseFile()).cancelled, true);
});
test('选择文件接口拒绝跨站请求，返回选择结果但不建立入口', async t => {
  let calls = 0;
  const context = { config: { host: '127.0.0.1', port: 0 }, attachServer() {}, workDocuments: { chooseFile: async () => { calls++; return { cancelled: true }; } } };
  const server = createServerApplication(context); await new Promise(r => server.listen(0, '127.0.0.1', r)); context.config.port = server.address().port;
  t.after(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${context.config.port}/api/work-documents/pick-file`;
  const send = origin => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: '{}' });
  assert.equal((await send('https://example.com')).status, 403); assert.equal(calls, 0);
  const response = await send(); assert.equal(response.status, 200); assert.equal((await response.json()).cancelled, true); assert.equal(calls, 1);
});
