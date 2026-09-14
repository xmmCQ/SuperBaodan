import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkDocuments } from '../lib/work-documents.mjs';
import { emptyDocuments, normalizeTarget, validateDocuments, moveItem } from '../public/core/work-documents.js';
import { parseDocumentMarkdown, mergeDocumentImport } from '../public/core/work-document-import.js';
import { createTempProject } from './helpers/temp-project.mjs';
import { createServerApplication } from '../server/app.mjs';
const doc = (target, id = 'one') => ({ id, name: '测试文档', categoryId: 'uncategorized', kind: 'file', target });
async function setup(t) {
  const temp = await createTempProject('work-documents-'); t.after(temp.cleanup);
  const opened = [], file = temp.resolve('中文 (测试) & 资料.txt'); await fs.writeFile(file, '原文保持不变');
  const manager = new WorkDocuments({ filePath: temp.resolve('data/work-documents.json'), launch: async target => opened.push(target) });
  return { temp, opened, file, manager };
}
test('目录初始为空；保存、版本冲突、备份及损坏配置保护', async t => {
  const { manager, file } = await setup(t), empty = await manager.read(); assert.equal(empty.documents.length, 0);
  const saved = await manager.save({ ...empty, documents: [doc(file)] });
  const outcomes = await Promise.allSettled([manager.save({ ...saved, documents: [] }), manager.save({ ...saved, documents: [] })]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(r => r.status === 'rejected').reason.statusCode, 409);
  assert.equal(JSON.parse(await fs.readFile(manager.filePath + '.bak', 'utf8')).documents.length, 1);
  await fs.writeFile(manager.filePath, '{broken');
  await assert.rejects(manager.save(saved), { statusCode: 409 });
  assert.equal(await fs.readFile(manager.filePath, 'utf8'), '{broken');
});
test('打开仅使用登记文件、版本匹配、真实文件和安全扩展名', async t => {
  const { manager, file, opened, temp } = await setup(t);
  const saved = await manager.save({ ...await manager.read(), documents: [doc(file)] });
  await manager.open({ id: 'one', revision: saved.revision, path: 'C:\\Windows\\evil.exe' });
  assert.equal(opened.length, 1); assert.equal(opened[0].toLowerCase(), file.toLowerCase());
  await assert.rejects(manager.open({ id: 'one', revision: 'old' }), { statusCode: 409 });
  await assert.rejects(manager.open({ id: 'unknown', revision: saved.revision }), { statusCode: 404 });
  await fs.rm(file); await assert.rejects(manager.open({ id: 'one', revision: saved.revision }), { statusCode: 404 });
  const outside = temp.resolve('payload.cmd'); await fs.writeFile(outside, 'never run');
  const folder = path.dirname(file), realFolder = temp.resolve('target'); await fs.mkdir(realFolder);
  // A directory named like a document is never a file.
  await fs.mkdir(file); await assert.rejects(manager.open({ id: 'one', revision: saved.revision }), { statusCode: 400 });
  assert.equal(opened.length, 1);
});
test('路径、协议、保留名称、重复项和限制均校验', () => {
  assert.equal(normalizeTarget('file', '"d:/资料/a/../书 (1).xlsx"'), 'D:\\资料\\书 (1).xlsx');
  assert.equal(normalizeTarget('url', 'https://EXAMPLE.com/a?q=1#x'), 'https://example.com/a?q=1#x');
  for (const value of ['C:\\a.exe', 'C:\\a.lnk', 'C:\\a.xlsm', '\\\\host\\a.txt', 'C:\\a.txt:stream', 'C:\\CON.txt', 'C:\\%TEMP%\\a.txt', '../a.txt', 'C:\\a.txt --run']) assert.throws(() => normalizeTarget('file', value));
  for (const value of ['javascript:alert(1)', 'file:///C:/a.txt', 'https://user:pass@example.com']) assert.throws(() => normalizeTarget('url', value));
  assert.throws(() => validateDocuments({ ...emptyDocuments(), documents: [doc('C:\\a.txt'), doc('c:/a.txt', 'two')] }));
  assert.throws(() => validateDocuments({ ...emptyDocuments(), categories: [{ id: 'uncategorized', name: '改名' }] }));
  const items = [{ id: 'a', cat: 1 }, { id: 'b', cat: 2 }, { id: 'c', cat: 1 }]; moveItem(items, 'c', -1, d => d.cat === 1); assert.deepEqual(items.map(d => d.id), ['c', 'b', 'a']);
});
test('Markdown只提取分类和链接，保留中文反斜杠与括号，跳过图片代码和私密正文', () => {
  const raw = '# 工作排班\n[本地](D:\\工作\\安排 (新版).xlsx)\n[在线](https://example.com/a?q=1#x)\nprivate-note-do-not-import\n![图片](https://example.com/image.png)\n```md\n[代码](D:\\code.txt)\n```\n[相对](../a.md)\n# 公共资料\n[参考](<C:\\资料\\a b.pdf>)';
  const rows = parseDocumentMarkdown(raw); assert.equal(rows.length, 4); assert.equal(rows[0].target, 'D:\\工作\\安排 (新版).xlsx'); assert.equal(rows[2].selected, false);
  const first = mergeDocumentImport(emptyDocuments(), rows); assert.equal(first.added, 3); assert.equal(first.invalid, 1);
  assert.equal(JSON.stringify(first.data).includes('private-note'), false);
  const again = mergeDocumentImport(first.data, rows); assert.equal(again.added, 0); assert.equal(again.duplicates, 3);
  assert.equal(rows[3].category, '公共资料');
});
test('下载模板可直接解析为3个分类6个示例，不导入使用说明', async () => {
  const template = await fs.readFile(new URL('../public/templates/work-documents.md', import.meta.url), 'utf8');
  const rows = parseDocumentMarkdown(template);
  assert.equal(rows.length, 6); assert.ok(rows.every(row => row.selected && !row.error));
  const result = mergeDocumentImport(emptyDocuments(), rows);
  assert.equal(result.added, 6); assert.equal(result.data.categories.length, 4);
  assert.equal(result.data.documents.filter(d => d.kind === 'file').length, 4);
  assert.equal(JSON.stringify(result.data).includes('使用说明'), false);
});

test('导入不覆盖已有名称；保留完整 URL 查询与片段；非法选中项阻止保存', () => {
  const rows = parseDocumentMarkdown('[A](https://example.com/a?x=1#part)\n[B](https://example.com/a?x=2#part)');
  const first = mergeDocumentImport(emptyDocuments(), rows); assert.equal(first.added, 2);
  rows[0].name = '更名'; const second = mergeDocumentImport(first.data, rows); assert.equal(second.data.documents[0].name, 'A');
  assert.throws(() => mergeDocumentImport(first.data, [{ name: '危险', category: '未分类', kind: 'url', target: 'javascript:alert(1)', selected: true }]));
});
test('真实 API 全局共用、拒绝跨站修改和未登记路径', async t => {
  const { manager, file, opened } = await setup(t);
  const context = { config: { host: '127.0.0.1', port: 0 }, workDocuments: manager, attachServer() {} };
  const server = createServerApplication(context); await new Promise(r => server.listen(0, '127.0.0.1', r)); context.config.port = server.address().port;
  t.after(() => new Promise(r => server.close(r))); const base = `http://127.0.0.1:${context.config.port}`;
  const initial = await (await fetch(base + '/api/work-documents')).json();
  const send = (url, body, origin) => fetch(base + url, { method: url.endsWith('/open') ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  assert.equal((await send('/api/work-documents', initial, 'https://example.com')).status, 403);
  const saved = await (await send('/api/work-documents', { ...initial, documents: [doc(file)] })).json();
  const fromAnotherProject = await (await fetch(base + '/api/work-documents?workspaceId=other')).json(); assert.equal(fromAnotherProject.documents.length, 1);
  assert.equal((await send('/api/work-documents/open', { id: 'one', revision: saved.revision })).status, 200); assert.equal(opened.length, 1);
  assert.equal((await send('/api/work-documents/open', { path: file })).status, 400);
});
