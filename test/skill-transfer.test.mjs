import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SkillManager, buildSkillMarkdown, parseSkillMarkdown } from '../lib/skill-manager.mjs';
import { skillTreeDigest, transferSkillDirectory } from '../lib/skill-transfer.mjs';
import { createTempProject } from './helpers/temp-project.mjs';
import { createServerApplication } from '../server/app.mjs';

async function fixture(t) {
  const temp = await createTempProject('skill-transfer-'); t.after(temp.cleanup);
  const agentDir = path.join(temp.root, 'agent'), cwd = path.join(temp.root, 'project');
  const roots = [path.join(agentDir, 'skills'), path.join(cwd, '.pi', 'skills')];
  for (const root of roots) await mkdir(root, { recursive: true });
  const manager = new SkillManager({ agentDir, cwd, backupDir: path.join(temp.root, 'backups'), env: { USERPROFILE: temp.root },
    piAdmin: { withMaintenance: operation => operation() }, execFileImpl: async () => ({ stdout: '1' }),
    loadSdk: async () => ({ DefaultResourceLoader: class {
      async reload() { this.skills = []; for (const root of roots) for (const name of await readdir(root)) {
        const filePath = path.join(root, name, 'SKILL.md');
        const parsed = parseSkillMarkdown(await readFile(filePath, 'utf8'));
        this.skills.push({ ...parsed, filePath });
      } }
      getSkills() { return { skills: this.skills }; }
    } }) });
  const source = path.join(roots[1], 'demo'); await mkdir(path.join(source, 'references'), { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), buildSkillMarkdown({ name: 'demo', description: '测试技能', body: '参见 references/test.bin', disableModelInvocation: true }));
  await writeFile(path.join(source, 'references', 'test.bin'), Buffer.from([0, 1, 255]));
  const payload = async () => { const skill = (await manager.list()).skills.find(s => s.name === 'demo'); return { scope: skill.scope, name: skill.name, id: skill.id, revision: skill.revision }; };
  return { manager, source, target: path.join(roots[0], 'demo'), payload, root: temp.root };
}
test('项目与全局双向整目录互转，内容、附件、调用设置及备份保留', async t => {
  const f = await fixture(t), original = await skillTreeDigest(f.source);
  const moved = await f.manager.transfer(await f.payload()); assert.equal(moved.scope, 'global');
  assert.equal(existsSync(f.source), false); assert.equal(await skillTreeDigest(f.target), original);
  const listed = (await f.manager.list()).skills[0]; assert.equal(listed.id, moved.skillId);
  await f.manager.transfer(await f.payload()); assert.equal(existsSync(f.target), false);
  assert.equal(await skillTreeDigest(f.source), original);
  assert.equal((await readdir(f.manager.backupDir)).length, 2);
});
test('同名目标、旧版本及忙碌时均拒绝，不改变原件', async t => {
  const f = await fixture(t), original = await skillTreeDigest(f.source), payload = await f.payload();
  await mkdir(f.target); await writeFile(path.join(f.target, 'SKILL.md'), buildSkillMarkdown({ name: 'demo', description: '目标' }));
  await assert.rejects(f.manager.transfer(payload), { statusCode: 409 });
  await rm(f.target, { recursive: true });
  await assert.rejects(f.manager.transfer({ ...payload, revision: 'old' }), { statusCode: 409 });
  f.manager.piAdmin.withMaintenance = () => { throw Object.assign(new Error('busy'), { statusCode: 409 }); };
  await assert.rejects(f.manager.transfer(payload), { statusCode: 409 });
  assert.equal(await skillTreeDigest(f.source), original); assert.equal(existsSync(f.target), false);
});
test('软件包管理的技能、子目录链接及目标根目录链接不可互转', async t => {
  const f = await fixture(t), payload = await f.payload();
  await writeFile(f.manager.projectLockPath, JSON.stringify({ skills: { demo: { source: 'owner/repo', sourceType: 'github' } } }));
  await assert.rejects(f.manager.transfer(payload), { statusCode: 403 });
  await rm(f.manager.projectLockPath);
  const outside = path.join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(f.source, 'linked'), 'junction');
  await assert.rejects(f.manager.transfer(await f.payload()), { statusCode: 403 });
  await rm(path.join(f.source, 'linked'));
  await rm(f.manager.globalRoot, { recursive: true }); await symlink(outside, f.manager.globalRoot, 'junction');
  await assert.rejects(f.manager.transfer(await f.payload()), { statusCode: 403 });
});
test('删除原目录中途失败，从备份恢复，撤回目标副本', async t => {
  const f = await fixture(t), original = await skillTreeDigest(f.source);
  await assert.rejects(transferSkillDirectory({ source: f.source, target: f.target, backupDir: f.manager.backupDir,
    removeSource: async source => { await rm(path.join(source, 'SKILL.md')); throw new Error('模拟删除失败'); } }), /模拟删除失败/);
  assert.equal(await skillTreeDigest(f.source), original); assert.equal(existsSync(f.target), false);
});
test('转换完成但运行时重载失败时，返回已转换及明确警告', async t => {
  const f = await fixture(t), payload = await f.payload();
  f.manager.piAdmin.withMaintenance = async operation => { await operation(); throw new Error('reload failed'); };
  const result = await f.manager.transfer(payload);
  assert.equal(result.moved, true); assert.equal(result.applied, false); assert.match(result.warning, /重启/);
  assert.equal(existsSync(f.source), false); assert.equal(existsSync(f.target), true);
});
test('打开目录仅使用服务器登记的 Skill 路径，不接受任意客户端路径', async t => {
  const f = await fixture(t), payload = await f.payload(), opened = [];
  f.manager.openDirectoryImpl = async directory => opened.push(directory);
  f.manager.loadSdk = async () => { throw new Error('打开目录不应扫描 SDK'); };
  f.manager.execFileImpl = async () => { throw new Error('打开目录不应检查 npx'); };
  await f.manager.openDirectory({ id: payload.id, path: 'C:\\Windows' });
  assert.equal(opened.length, 1); assert.equal(opened[0].toLowerCase(), f.source.toLowerCase());
  await assert.rejects(f.manager.openDirectory({ id: 'missing', path: 'C:\\Windows' }), { statusCode: 404 });
  assert.equal(opened.length, 1);
});

test('技能修改后旧路径缓存失效，重新加载列表后可打开', async t => {
  const f = await fixture(t), payload = await f.payload(), opened = [];
  f.manager.openDirectoryImpl = async directory => opened.push(directory);
  await f.manager.updateCustom({ scope: 'project', name: 'demo', description: '新描述', body: '新正文' });
  await assert.rejects(f.manager.openDirectory({ id: payload.id }), { statusCode: 404 });
  assert.equal(opened.length, 0);
  await f.manager.list(); await f.manager.openDirectory({ id: payload.id });
  assert.equal(opened.length, 1);
});

test('转换接口必须绑定当前工作区，陈旧请求不会执行', async t => {
  let calls = 0;
  const context = { config: { host: '127.0.0.1', port: 0 }, activeWorkspace: { id: 'A' }, piRuntime: {}, workspaceService: {},
    assertActiveWorkspace() {}, attachServer() {}, skillManager: { transfer: async () => { calls++; return { moved: true }; }, openDirectory: async () => { calls++; return { opened: true }; } } };
  const server = createServerApplication(context); await new Promise(r => server.listen(0, '127.0.0.1', r)); context.config.port = server.address().port;
  t.after(() => new Promise(r => server.close(r)));
  const send = workspaceId => fetch(`http://127.0.0.1:${context.config.port}/api/skills/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) });
  assert.equal((await send('B')).status, 409); assert.equal((await send()).status, 400); assert.equal(calls, 0);
  assert.equal((await send('A')).status, 200); assert.equal(calls, 1);
  const open = workspaceId => fetch(`http://127.0.0.1:${context.config.port}/api/skills/open-directory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) });
  assert.equal((await open('B')).status, 409); assert.equal((await open()).status, 400); assert.equal(calls, 1);
  assert.equal((await open('A')).status, 200); assert.equal(calls, 2);
});
