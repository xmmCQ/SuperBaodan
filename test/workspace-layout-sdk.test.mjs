import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSdkHost, findSdkEntry } from '../app/services/domain/pi-sdk-factory.mjs';
import { prepareWorkspace } from '../app/services/domain/workspace-layout.mjs';
import { SkillManager } from '../app/services/domain/skill-manager.mjs';

test('真实SDK加载原项目与Park规则、技能，会话替换和重载不丢布局（不调用模型）', { timeout: 60000 }, async t => {
  if (process.env.SUPER_BAODAN_TEST_SDK !== '1') return t.skip('真实SDK联调需显式设置 SUPER_BAODAN_TEST_SDK=1');
  if (!findSdkEntry()) return t.skip('未安装Windows Pi SDK');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'park-sdk-'));
  let host;
  t.after(async () => { await host?.dispose(); await rm(temp, { recursive: true, force: true }); });
  const cwd = path.join(temp, '项目 A'), agentDir = path.join(temp, 'agent'), sessionDir = path.join(temp, 'sessions');
  await Promise.all([cwd, agentDir, sessionDir].map(p => mkdir(p, { recursive: true })));
  await writeFile(path.join(cwd, 'AGENTS.md'), 'USER_RULE_UNCHANGED');
  const layout = await prepareWorkspace(cwd);
  await writeFile(layout.projectPromptFile, 'BAODAN_RULE');
  for (const [root, name] of [[layout.projectSkillRoot, 'park-skill'], [path.join(cwd, '.pi', 'skills'), 'user-skill']]) {
    const dir = path.join(root, name); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test fixture\n---\nFixture instructions`);
  }
  ({ host } = await createSdkHost({ cwd, agentDir, sessionDir, log: { warn() {} } }));
  const firstId = host.session.sessionManager.getSessionId();
  assert.equal(host.session.sessionManager.getCwd(), cwd);
  assert.match(host.session.systemPrompt, /USER_RULE_UNCHANGED/);
  assert.match(host.session.systemPrompt, /BAODAN_RULE/);
  assert.ok(host.session.systemPrompt.includes(firstId));
  await host.session.reload();
  assert.equal(host.session.systemPrompt.split('## 宝蛋工作区目录约定').length, 2);
  await host.newSession();
  const nextId = host.session.sessionManager.getSessionId();
  assert.notEqual(nextId, firstId);
  assert.ok(host.session.systemPrompt.includes(nextId));
  assert.ok(!host.session.systemPrompt.includes(firstId));
  const manager = new SkillManager({ cwd, agentDir, backupDir: path.join(temp, 'backups'), env: process.env,
    piAdmin: { withMaintenance: fn => fn() }, execFileImpl: async () => ({ stdout: 'fixture' }) });
  const list = await manager.list();
  assert.equal(list.skills.find(s => s.name === 'park-skill').scope, 'project');
  assert.equal(list.skills.find(s => s.name === 'user-skill').scope, 'other');
  assert.equal(list.skills.find(s => s.name === 'user-skill').writable, false);
  for (const name of ['park-skill', 'user-skill']) assert.ok(host.session.resourceLoader.getSkills().skills.some(s => s.name === name));
});
