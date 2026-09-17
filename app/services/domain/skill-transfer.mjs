import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { statusError } from './pi-admin.mjs';

const inside = (file, root) => { const rel = path.relative(root, file); return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
export async function skillTreeDigest(root) {
  const entries = []; let count = 0;
  async function walk(directory) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw statusError(403, '不能转换包含链接或异常目录的 Skill');
    for (const name of (await readdir(directory)).sort()) {
      if (++count > 10000) throw statusError(413, 'Skill 文件过多，请手动迁移');
      const file = path.join(directory, name), stat = await lstat(file), relative = path.relative(root, file);
      if (stat.isSymbolicLink()) throw statusError(403, '不能转换包含符号链接的 Skill');
      if (stat.isDirectory()) { entries.push(['dir', relative]); await walk(file); }
      else if (stat.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        entries.push(['file', relative, stat.size, hash.digest('hex')]);
      } else throw statusError(403, '不能转换包含异常文件的 Skill');
    }
  }
  await walk(root);
  return JSON.stringify(entries);
}
async function safeRoot(root) {
  let existing = root;
  while (true) {
    try { await lstat(existing); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; existing = path.dirname(existing); }
  }
  if (path.resolve(await realpath(existing)).toLowerCase() !== path.resolve(existing).toLowerCase()) throw statusError(403, 'Skill 目标目录不能经过符号链接');
  await mkdir(root, { recursive: true });
}
export async function transferSkillDirectory({ source, target, backupDir, expectedRevision, removeSource = rm }) {
  if (inside(target, source) || inside(source, target) || inside(backupDir, source) || inside(backupDir, target)) throw statusError(403, 'Skill 目录不能互相嵌套');
  await safeRoot(path.dirname(target));
  try { await lstat(target); throw statusError(409, '目标位置已有同名 Skill，不会覆盖'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const digest = await skillTreeDigest(source);
  if (expectedRevision && JSON.parse(digest).find(entry => entry[0] === 'file' && entry[1] === 'SKILL.md')?.[3] !== expectedRevision) throw statusError(409, 'Skill 已变化，请刷新后重试');
  const backup = path.join(backupDir, `skills-transfer-${randomUUID()}`), saved = path.join(backup, 'skill');
  await mkdir(backup, { recursive: true });
  await cp(source, saved, { recursive: true, dereference: false, force: false, errorOnExist: true });
  if (await skillTreeDigest(saved) !== digest) throw statusError(409, '备份期间 Skill 已变化，未转换');
  await writeFile(path.join(backup, 'transfer.json'), JSON.stringify({ source, target, at: new Date().toISOString() }));
  let reserved = false, deleting = false;
  try {
    // Reserve with mkdir instead of rename: POSIX rename can overwrite an empty directory.
    await mkdir(target); reserved = true;
    for (const name of await readdir(saved)) await cp(path.join(saved, name), path.join(target, name), { recursive: true, dereference: false, force: false, errorOnExist: true });
    if (await skillTreeDigest(target) !== digest || await skillTreeDigest(source) !== digest) throw statusError(409, '转换期间 Skill 已变化，已取消');
    deleting = true;
    await removeSource(source, { recursive: true, force: false });
    return { moved: true };
  } catch (error) {
    if (deleting) {
      try {
        await cp(saved, source, { recursive: true, dereference: false });
        if (await skillTreeDigest(source) !== digest) throw new Error('恢复校验失败');
      } catch (restoreError) {
        throw statusError(500, `转换失败，原目录恢复未完成；目标副本与备份已保留。备份：${backup}；${restoreError.message}`);
      }
    }
    if (reserved) await rm(target, { recursive: true, force: true }).catch(() => { error.message += `；目标残留请手动清理，备份：${backup}`; });
    if (error.code === 'EEXIST') throw statusError(409, '目标位置已有同名 Skill，不会覆盖');
    throw error;
  }
}
