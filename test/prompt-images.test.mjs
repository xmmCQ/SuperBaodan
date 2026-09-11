import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { validatePromptPayload, validatePromptImages, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from '../public/core/prompt-images.js';
import { readJsonBody } from '../server/response.mjs';
import { createServerApplication } from '../server/app.mjs';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './helpers/browser-harness.mjs';
const image = size => ({ type: 'image', mimeType: 'image/png', data: Buffer.alloc(size, 1).toString('base64') });

test('统一图片限制支持800KiB，校验数量、单张、总量、类型和Base64', async () => {
  validatePromptPayload({ message: 'image', images: [image(800 * 1024)] });
  assert.throws(() => validatePromptImages(Array.from({ length: 5 }, () => image(1))), { statusCode: 413 });
  assert.throws(() => validatePromptImages([image(MAX_IMAGE_BYTES + 1)]), { statusCode: 413 });
  assert.throws(() => validatePromptImages([image(4 * 1024 * 1024), image(4 * 1024 * 1024), image(4 * 1024 * 1024)]), { statusCode: 413 });
  validatePromptImages([image(MAX_TOTAL_IMAGE_BYTES / 2), image(MAX_TOTAL_IMAGE_BYTES / 2)]);
  assert.throws(() => validatePromptImages([{ ...image(1), mimeType: 'image/svg+xml' }]), { statusCode: 400 });
  assert.throws(() => validatePromptImages([{ ...image(1), data: 'invalid?' }]), { statusCode: 400 });
  await assert.rejects(readJsonBody(Readable.from([Buffer.alloc(1024 * 1024 + 1)])), { statusCode: 413 });
});
test('HTTP图片请求超过旧1MiB限制仍可发送，超出单张限制明确413', async t => {
  let sends = 0;
  const context = { config: { host: '127.0.0.1', port: 0 }, piAdmin: { maintenanceActive: false }, piRuntime: { send: async () => { sends++; return null; } }, assertActiveWorkspace() {}, attachServer() {} };
  const server = createServerApplication(context); await new Promise(r => server.listen(0, '127.0.0.1', r)); context.config.port = server.address().port;
  t.after(() => new Promise(r => server.close(r)));
  const send = images => fetch(`http://127.0.0.1:${context.config.port}/api/agent/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: 'test', images }) });
  assert.equal((await send([image(800 * 1024)])).status, 200);
  assert.equal((await send([image(MAX_IMAGE_BYTES + 1)])).status, 413); assert.equal(sends, 1);
});
test('浏览器明确拒绝后恢复原附件，并保留后选附件和新文字；超限预检查不清空', { timeout: 20000 }, async t => {
  if (!edgeAvailable()) return t.skip('未安装Microsoft Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await launchBrowser({ width: 1600, height: 1000 });
  await browser.addInitScript(`const original=fetch;window.fetch=(...args)=>{if(String(args[0]).includes('/api/agent/command')&&JSON.parse(args[1]?.body||'{}').type==='prompt')return new Promise(resolve=>{window.rejectImageSend=()=>resolve(new Response(JSON.stringify({error:'模拟明确拒绝'}),{status:413,headers:{'Content-Type':'application/json'}}));});return original(...args);};`);
  await browser.navigate(`http://127.0.0.1:${fixture.port}/assistant.html`);
  await browser.waitFor("document.querySelectorAll('#messages > .message').length>=2");
  const add = (name, size) => browser.evaluate(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(${size})],${JSON.stringify(name)},{type:'image/png'}));imageInput.files=transfer.files;imageInput.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await add('original.png', 800 * 1024); await browser.waitFor("document.querySelectorAll('.attachment-chip').length===1");
  await browser.evaluate("promptInput.value='原问题';sendButton.click()"); await browser.waitFor('Boolean(window.rejectImageSend)');
  await add('new.png', 10); await browser.waitFor("document.querySelectorAll('.attachment-chip').length===1");
  await browser.evaluate("promptInput.value='新的草稿';rejectImageSend()"); await browser.waitFor("document.querySelectorAll('.attachment-chip').length===2");
  assert.equal(await browser.evaluate('promptInput.value'), '新的草稿');
  assert.ok(await browser.evaluate("attachments.textContent.includes('original.png')&&attachments.textContent.includes('new.png')"));
  await add('too-large.png', 6 * 1024 * 1024);
  await browser.waitFor("document.body.textContent.includes('单张不超过5 MiB')");
  assert.equal(await browser.evaluate("document.querySelectorAll('.attachment-chip').length"), 2);
  assert.deepEqual(browser.issues, []);
});
