import { prepareWorkspace } from '../app/services/domain/workspace-layout.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRuntimeContext } from '../app/services/runtime-context.mjs';
import path from 'node:path';
import { SkillManager } from '../app/services/domain/skill-manager.mjs';
import { buildSkillMarkdown, parseSkillMarkdown } from '../app/services/domain/skill-markdown.mjs';
import { findSdkEntry } from '../app/services/domain/pi-sdk-factory.mjs';
import { createTempProject } from './helpers/temp-project.mjs';

async function fixture(t, realSdk = false) {
  const temp = await createTempProject('sb-skill-collisions-'); t.after(temp.cleanup);
  const agentDir = await temp.ensureDir('agent'), cwd = await temp.ensureDir('project');
  await prepareWorkspace(cwd);
  const files = ['agent/skills/review-duplicate-fixture/SKILL.md', 'project/BaodanPark/.pi/skills/review-duplicate-fixture/SKILL.md'].map(file => temp.resolve(file));
  const content = buildSkillMarkdown({ name: 'review-duplicate-fixture', description: '隔离同名测试', body: '测试正文' });
  for (const file of files) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); }
  const loader = async () => ({ SettingsManager: { fromStorage: () => ({}) }, DefaultResourceLoader: class {
    async reload() {
      const entries = [];
      for (const filePath of files) {
        try { entries.push({ ...parseSkillMarkdown(await readFile(filePath, 'utf8')), filePath }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.result = { skills: entries.slice(0, 1), diagnostics: entries.slice(1).map(skill => ({
        type: 'collision', path: skill.filePath, message: 'name collision',
        collision: { resourceType: 'skill', name: skill.name, winnerPath: entries[0].filePath, loserPath: skill.filePath },
      })) };
    }
    getSkills() { return this.result; }
  } });
  const manager = new SkillManager({ agentDir, cwd, backupDir: temp.resolve('backups'), env: { ...process.env, USERPROFILE: temp.root },
    piAdmin: { withMaintenance: operation => operation() }, execFileImpl: async () => ({ stdout: '1' }),
    ...(realSdk ? {} : { loadSdk: loader }),
  });
  return { temp, files, manager, content, list: async () => (await manager.list()).skills.filter(skill => skill.name === 'review-duplicate-fixture') };
}

test('SDK过滤掉的同名副本仍独立列出，重复双方均标记且保留编辑删除能力', async t => {
  const f = await fixture(t), skills = await f.list();
  assert.equal(skills.length, 2);
  assert.equal(new Set(skills.map(skill => skill.id)).size, 2);
  assert.deepEqual(new Set(skills.map(skill => skill.loadState)), new Set(['selected', 'shadowed']));
  for (const skill of skills) {
    assert.equal(skill.collision.kind, 'duplicate'); assert.equal(skill.writable, true);
    assert.equal(skill.collision.peers.length, 1); assert.notEqual(skill.collision.peers[0].id, skill.id);
  }
  await f.manager.deleteCustom({ scope: 'project', name: 'review-duplicate-fixture' });
  const remaining = await f.list();
  assert.equal(remaining.length, 1); assert.equal(remaining[0].collision, undefined);
  assert.equal(await readFile(f.files[0], 'utf8'), f.content);
});

test('正文或附属文件不同均为冲突，修改后刷新重新核验', async t => {
  const f = await fixture(t);
  await writeFile(f.files[1], f.content + '\n其他指令');
  assert.ok((await f.list()).every(skill => skill.collision.kind === 'conflict'));
  await writeFile(f.files[1], f.content);
  await f.temp.write('project/BaodanPark/.pi/skills/review-duplicate-fixture/references/rule.txt', '仅项目副本拥有的参考资料');
  assert.ok((await f.list()).every(skill => skill.collision.kind === 'conflict'));
  await rm(path.join(path.dirname(f.files[1]), 'references'), { recursive: true });
  assert.ok((await f.list()).every(skill => skill.collision.kind === 'duplicate'));
});

test('无法完整比较的链接目录标记待核验，不冒充内容一致', async t => {
  const f = await fixture(t), outside = await f.temp.ensureDir('outside');
  await symlink(outside, path.join(path.dirname(f.files[1]), 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok((await f.list()).every(skill => skill.collision.kind === 'unverified'));
});

test('启动和重启不再把项目技能复制到全局', async t => {
  const temp = await createTempProject('sb-no-skill-copy-'); t.after(temp.cleanup);
  const source = 'workspace/.pi/skills/ultimate-workhorse/SKILL.md';
  const content = buildSkillMarkdown({ name: 'ultimate-workhorse', description: '仅项目', body: '保留项目副本' });
  await temp.write(source, content);
  const config = {
    workspaceDir: temp.resolve('workspace'), piAgentDir: temp.resolve('agent'), piSessionDir: temp.resolve('sessions'),
    backupDir: temp.resolve('backups'), todoFile: temp.resolve('todo.md'), dailyRecordFile: temp.resolve('records.json'),
    vskillFile: temp.resolve('vskills.json'), workspaceFile: temp.resolve('workspaces.json'),
  };
  for (let i = 0; i < 2; i++) {
    const context = await createRuntimeContext(config);
    try {
      assert.equal(existsSync(temp.resolve('agent/skills/ultimate-workhorse')), false);
      assert.equal(await readFile(temp.resolve(source), 'utf8'), content);
    } finally { await context.shutdown(); }
  }
});

test('真实SDK诊断可恢复被遮蔽的全局/项目技能', {
  skip: process.platform !== 'win32' || process.env.SUPER_BAODAN_TEST_SDK !== '1' || !findSdkEntry(), timeout: 30000,
}, async t => {
  const f = await fixture(t, true), skills = await f.list();
  assert.equal(skills.length, 2);
  assert.equal(skills.filter(skill => skill.loadState === 'selected').length, 1);
  assert.equal(skills.filter(skill => skill.loadState === 'shadowed').length, 1);
  assert.ok(skills.every(skill => skill.collision.kind === 'duplicate'));
});
