import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { selectTests, parseArguments } from '../scripts/test.mjs';
import { layers } from './layers.mjs';

const registry = { unit: ['a.test.mjs'], browser: ['b.test.mjs'] };
const files = ['a.test.mjs', 'b.test.mjs'];
test('测试分层完整且互斥，不因整理丢失回归文件', () => {
  const available = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.mjs'));
  assert.deepEqual(selectTests('all', [], available), available.sort());
  assert.equal(layers.unit.some(f => layers.browser.includes(f) || layers.desktop.includes(f)), false);
  assert.ok(layers.integration.includes('task-store.test.mjs'));
  assert.ok(layers.integration.includes('session-sync-races.test.mjs'));
  assert.ok(layers.desktop.includes('desktop-draft-exit.test.mjs'));
});
test('新测试未分类、重复分类、陈旧条目均显式失败', () => {
  assert.throws(() => selectTests('all', [], [...files,'c.test.mjs'], registry), /归类新测试/);
  assert.throws(() => selectTests('all', [], files, {...registry,desktop:['a.test.mjs']}), /重复归类/);
  assert.throws(() => selectTests('all', [], ['a.test.mjs'], registry), /文件不存在/);
});
test('筛选不跨层、不重复，拼错文件名不能静默跑空', () => {
  assert.deepEqual(selectTests('unit',[],files,registry),['a.test.mjs']);
  assert.deepEqual(selectTests('all',['test/a.test.mjs','a.test'],files,registry),['a.test.mjs']);
  assert.throws(() => selectTests('unit',['b.test'],files,registry), /没有匹配/);
  assert.throws(() => selectTests('oops',[],files,registry), /未知/);
  assert.deepEqual(parseArguments(['browser','settings','--list','--test-name-pattern','滚动']), {scope:'browser',filters:['settings'],list:true,nodeOptions:['--test-name-pattern=滚动']});
  assert.throws(() => parseArguments(['unit','--test-name-pattern']), /缺少/);
  assert.throws(() => parseArguments(['unit','--unknown']), /不支持/);
});
