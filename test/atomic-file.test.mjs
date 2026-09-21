import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { createTempProject } from './helpers/temp-project.mjs';
import { writeJsonAtomic } from '../app/services/atomic-file.mjs';

async function fixture(t) {
  const temp = await createTempProject('atomic-json-'); t.after(temp.cleanup); return temp;
}
test('原子JSON写入保留缩进、换行、UUID注入与私有权限', async t => {
  const temp = await fixture(t); let ids = 0;
  const file = temp.resolve('data.json');
  await writeJsonAtomic(file, { text: '中文' }, { randomUUID: () => `test-${++ids}` });
  assert.equal(await readFile(file, 'utf8'), '{\n  "text": "中文"\n}\n');
  assert.equal(ids, 1); assert.deepEqual(await readdir(temp.root), ['data.json']);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});
test('序列化或写入失败不改变原文件，不删除其他文件', async t => {
  const temp = await fixture(t); const file = await temp.write('data.json', 'original');
  await temp.write('unrelated.tmp', 'keep');
  await assert.rejects(writeJsonAtomic(file, { big: 1n }));
  t.mock.method(Date, 'now', () => 12345);
  const blocked = `${file}.super-baodan-${process.pid}-12345-fixed.tmp`;
  await mkdir(blocked);
  await assert.rejects(writeJsonAtomic(file, {}, { randomUUID: () => 'fixed' }));
  assert.equal(await readFile(file, 'utf8'), 'original');
  assert.equal(await readFile(temp.resolve('unrelated.tmp'), 'utf8'), 'keep');
  assert.equal((await stat(blocked)).isDirectory(), true);
});
test('重命名失败清除本次临时文件，保留原目标及旁边文件', async t => {
  const temp = await fixture(t); await temp.write('target/keep.txt', 'original'); await temp.write('other.tmp', 'keep');
  await assert.rejects(writeJsonAtomic(temp.resolve('target'), { next: true }, { randomUUID: () => 'rename-failure' }));
  assert.equal(await readFile(temp.resolve('target/keep.txt'), 'utf8'), 'original');
  assert.deepEqual((await readdir(temp.root)).sort(), ['other.tmp', 'target']);
});
