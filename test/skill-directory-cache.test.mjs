import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SkillDirectoryCache } from '../lib/skill-directory-cache.mjs';
import { createTempProject } from './helpers/temp-project.mjs';

async function fixture(t) {
  const temp = await createTempProject('skill-directory-cache-'); t.after(temp.cleanup);
  const directory = path.join(temp.root, 'skill'), other = path.join(temp.root, 'other');
  for (const dir of [directory, other]) { await mkdir(dir); await writeFile(path.join(dir, 'SKILL.md'), 'test'); }
  const skill = { id: 'known', filePath: path.join(directory, 'SKILL.md') }, cache = new SkillDirectoryCache();
  await cache.publish([skill], cache.begin());
  return { cache, skill, directory, other };
}
test('缓存只接受登记的 ID，删除文件后拒绝打开', async t => {
  const f = await fixture(t);
  assert.equal((await f.cache.resolve(f.skill.id)).toLowerCase(), f.directory.toLowerCase());
  await assert.rejects(f.cache.resolve(f.other), { statusCode: 404 });
  await rm(f.skill.filePath);
  await assert.rejects(f.cache.resolve(f.skill.id), { statusCode: 404 });
});
test('目录被替换成指向其他位置的链接时拒绝打开', async t => {
  const f = await fixture(t);
  await rm(f.directory, { recursive: true }); await symlink(f.other, f.directory, 'junction');
  await assert.rejects(f.cache.resolve(f.skill.id), { statusCode: 409 });
});
test('旧列表、变更前的异步列表不能恢复已失效的缓存', async t => {
  const f = await fixture(t);
  const old = f.cache.begin(), latest = f.cache.begin();
  await f.cache.publish([], latest); await f.cache.publish([f.skill], old);
  await assert.rejects(f.cache.resolve(f.skill.id), { statusCode: 404 });
  const pending = f.cache.publish([f.skill], f.cache.begin()); f.cache.clear(); await pending;
  await assert.rejects(f.cache.resolve(f.skill.id), { statusCode: 404 });
});
