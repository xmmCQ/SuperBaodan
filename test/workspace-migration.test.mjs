import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMigration, stageMigration, commitMigration, rollbackMigration } from '../scripts/migrate-baodan-park.mjs';
import { prepareWorkspace } from '../app/services/domain/workspace-layout.mjs';

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'park-migrate-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'workspace'); await mkdir(root);
  await writeFile(path.join(root, 'AGENTS.md'), 'original instructions');
  await writeFile(path.join(root, 'helper.py'), 'do not execute');
  const file = await createMigration({ root, backupDir: path.join(temp, 'backups'), pairs: [
    { source: 'AGENTS.md', target: 'AGENTS.md' }, { source: 'helper.py', target: 'tmp/legacy/helper.py' },
  ] });
  return { root, file };
}

test('迁移保留内容、源校验后提交，可幂等再次提交并回滚', async t => {
  const { root, file } = await fixture(t);
  await stageMigration(file); await stageMigration(file);
  await assert.rejects(prepareWorkspace(root), /迁移尚未完成/);
  const m = await commitMigration(file, async layout => { assert.equal(await readFile(layout.projectPromptFile, 'utf8'), 'original instructions'); });
  assert.equal(m.state, 'complete');
  await assert.rejects(readFile(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
  await commitMigration(file, async () => {});
  await rollbackMigration(file);
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'original instructions');
  assert.equal(await readFile(path.join(root, 'helper.py'), 'utf8'), 'do not execute');
});

test('规划后新出现的Park不能被迁移接管或覆盖', async t => {
  const { root, file } = await fixture(t);
  const layout = await prepareWorkspace(root);
  await writeFile(layout.projectPromptFile, '后来创建的指令');
  await assert.rejects(stageMigration(file), /目标目录已出现/);
  assert.equal(await readFile(layout.projectPromptFile, 'utf8'), '后来创建的指令');
});

test('并发修改源文件时停止提交，不删除变化后的源文件', async t => {
  const { root, file } = await fixture(t); await stageMigration(file);
  await writeFile(path.join(root, 'helper.py'), 'external edit');
  await assert.rejects(commitMigration(file, async () => {}), /发生变化/);
  assert.equal(await readFile(path.join(root, 'helper.py'), 'utf8'), 'external edit');
});

test('SDK验收失败保留全部源文件，目标被修改时拒绝回滚覆盖', async t => {
  const { root, file } = await fixture(t); await stageMigration(file);
  await assert.rejects(commitMigration(file, async () => { throw new Error('SDK validation failed'); }), /SDK validation/);
  assert.equal(await readFile(path.join(root, 'helper.py'), 'utf8'), 'do not execute');
  const target = path.join(root, 'BaodanPark', 'tmp', 'legacy', 'helper.py');
  await writeFile(target, 'new user content');
  await assert.rejects(rollbackMigration(file), /发生变化/);
  assert.equal(await readFile(target, 'utf8'), 'new user content');
});
