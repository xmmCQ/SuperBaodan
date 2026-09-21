import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareWorkspace, workspaceLayoutPrompt } from '../app/services/domain/workspace-layout.mjs';
import { combineProjectSettings, createWorkspaceSettings } from '../app/services/domain/workspace-resources.mjs';
import { WorkspaceService } from '../app/services/domain/workspace.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'park-中文 空格-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('布局幂等且会话路径隔离，不覆盖用户规则与宝蛋指令', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'AGENTS.md'), '用户项目规则');
  const first = await prepareWorkspace(root, { sessionId: 'session-1' });
  await writeFile(first.projectPromptFile, '自定义宝蛋指令');
  const second = await prepareWorkspace(root, { sessionId: 'session-2' });
  assert.equal(await readFile(second.projectPromptFile, 'utf8'), '自定义宝蛋指令');
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), '用户项目规则');
  assert.notEqual(first.sessionScratchRoot, second.sessionScratchRoot);
  assert.equal(first.defaultDeliveryRoot, first.workspaceRoot);
  assert.match(workspaceLayoutPrompt(second), /正式项目源码在原位置/);
  await assert.rejects(prepareWorkspace(root, { sessionId: '../escape' }), /会话标识/);
});

test('拒绝普通文件、未标记非空目录、高版本和嵌套Park', async t => {
  const root = await fixture(t), park = path.join(root, 'BaodanPark');
  await writeFile(park, '用户文件'); await assert.rejects(prepareWorkspace(root), /冲突/);
  await rm(park); await mkdir(park); await writeFile(path.join(park, 'user.txt'), '保留');
  await assert.rejects(prepareWorkspace(root), /非空/);
  await rm(path.join(park, 'user.txt'));
  const layout = await prepareWorkspace(root);
  await assert.rejects(prepareWorkspace(layout.parkRoot), /所属工作区/);
  await writeFile(layout.markerFile, JSON.stringify({ owner: 'SuperBaodan', version: 99 }));
  await assert.rejects(prepareWorkspace(root), /版本/);
});

test('管理目录及关键文件拒绝junction和符号链接', async t => {
  const root = await fixture(t), outside = await fixture(t);
  await symlink(outside, path.join(root, 'BaodanPark'), 'junction');
  await assert.rejects(prepareWorkspace(root), /链接|junction/);
  await rm(path.join(root, 'BaodanPark'));
  const layout = await prepareWorkspace(root);
  await rm(layout.projectSkillRoot, { recursive: true }); await symlink(outside, layout.projectSkillRoot, 'junction');
  await assert.rejects(prepareWorkspace(root), /链接|junction/);
});

test('默认文件树及搜索不进入过程目录，显式进入仍可查看', async t => {
  const root = await fixture(t), layout = await prepareWorkspace(root);
  await writeFile(path.join(layout.cacheRoot, 'private-history.txt'), '历史缓存');
  const files = await new WorkspaceService(root).initialize();
  const park = (await files.tree()).entries.find(e => e.name === 'BaodanPark');
  assert.equal(park.processDirectory, true); assert.equal(park.children, undefined);
  assert.deepEqual(await files.search('private-history'), []);
  assert.ok((await files.tree('BaodanPark')).entries.some(e => e.name === 'cache'));
});

test('用户项目和Park配置分开读取，冲突明确拒绝', async t => {
  assert.deepEqual(combineProjectSettings({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.throws(() => combineProjectSettings({ a: 1 }, { a: 2 }), /冲突/);
  const root = await fixture(t), layout = await prepareWorkspace(root), agent = path.join(root, 'agent');
  await mkdir(path.join(root, '.pi'));
  const original = path.join(root, '.pi', 'settings.json');
  await writeFile(original, JSON.stringify({ shellCommandPrefix: 'user-prefix' }));
  let storage;
  createWorkspaceSettings({ SettingsManager: { fromStorage(s) { storage = s; return {}; } } }, root, agent);
  storage.withLock('project', current => {
    assert.equal(JSON.parse(current).shellCommandPrefix, 'user-prefix');
    return JSON.stringify({ ...JSON.parse(current), enableSkillCommands: false });
  });
  assert.deepEqual(JSON.parse(await readFile(layout.projectSettingsFile, 'utf8')), { enableSkillCommands: false });
  assert.deepEqual(JSON.parse(await readFile(original, 'utf8')), { shellCommandPrefix: 'user-prefix' });
});
