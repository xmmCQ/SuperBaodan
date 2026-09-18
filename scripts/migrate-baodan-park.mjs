import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareWorkspace, assertManagedPath, DEFAULT_PROJECT_PROMPT } from '../app/services/domain/workspace-layout.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = e => { if (e.code === 'ENOENT') return null; throw e; };
const inside = (root, file) => { const r = path.relative(root, file); return r && !r.startsWith('..') && !path.isAbsolute(r); };
async function json(file, data) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  await rename(tmp, file);
}
async function digest(file) {
  const st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`不是普通迁移文件：${file}`);
  const bytes = await readFile(file);
  return { size: bytes.length, hash: hash(bytes) };
}
async function verify(file, item) {
  const now = await digest(file);
  if (now.hash !== item.hash || now.size !== item.size) throw new Error(`文件发生变化，停止迁移：${file}`);
}
async function safeSource(root, file) {
  if (!inside(root, file)) throw new Error('迁移源必须位于工作区内部');
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part);
    const st = await lstat(current);
    if (st.isSymbolicLink()) throw new Error(`迁移源不能经过链接：${current}`);
  }
}

// pairs is an explicit allowlist, never a wildcard over user business files.
export async function createMigration({ root, backupDir, registryFile, pairs }) {
  root = await realpath(root);
  const park = path.join(root, 'BaodanPark');
  if (await lstat(park).catch(absent)) throw new Error('目标 BaodanPark 已存在；请恢复已有清单，不另建迁移');
  const files = [], sourceDirectories = [];
  async function visit(source, target) {
    if (!inside(root, source) || !inside(park, target)) throw new Error('迁移路径越界');
    await safeSource(root, source);
    const st = await lstat(source);
    if (st.isDirectory()) {
      sourceDirectories.push(source);
      for (const name of (await readdir(source)).sort()) await visit(path.join(source, name), path.join(target, name));
    } else files.push({ source, target, ...await digest(source), removed: false });
  }
  for (const pair of pairs) await visit(path.join(root, pair.source), path.join(park, pair.target));
  const dir = path.join(backupDir, `baodan-park-${randomUUID()}`);
  if (inside(root, dir) || dir === root) throw new Error('迁移备份不能放在工作区内');
  await mkdir(path.join(dir, 'files'), { recursive: true });
  const manifest = { version: 1, root, park, state: 'planned', createdAt: new Date().toISOString(), files, sourceDirectories, registryFile };
  for (let i = 0; i < files.length; i++) {
    const item = files[i]; item.backup = path.join(dir, 'files', String(i));
    await copyFile(item.source, item.backup, 1); await verify(item.backup, item); await verify(item.source, item);
  }
  if (registryFile) { await copyFile(registryFile, path.join(dir, 'workspaces.json'), 1); manifest.registryHash = hash(await readFile(registryFile)); }
  const file = path.join(dir, 'migration.json');
  await json(file, manifest);
  return file;
}

export async function stageMigration(file) {
  const m = JSON.parse(await readFile(file, 'utf8'));
  if (['staged', 'complete'].includes(m.state)) { await verifyTargets(m); return m; }
  if (!['planned', 'initializing', 'copying'].includes(m.state)) throw new Error(`不能从 ${m.state} 继续复制`);
  for (const item of m.files) { await safeSource(m.root, item.source); await verify(item.source, item); await verify(item.backup, item); }
  if (m.state === 'planned') {
    if (await lstat(m.park).catch(absent)) throw new Error('规划后目标目录已出现，不能自动接管');
    m.state = 'initializing'; await json(file, m);
  }
  if (m.state === 'initializing') {
    await mkdir(m.park).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const st = await lstat(m.park);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('迁移目录出现链接或类型冲突');
    const markerFile = path.join(m.park, '.baodan.json');
    const markerInfo = await lstat(markerFile).catch(absent);
    if (markerInfo) {
      if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new Error('迁移标记不能是链接或异常文件');
      const marker = JSON.parse(await readFile(markerFile, 'utf8'));
      if (marker.migration?.manifest !== file) throw new Error('目标目录不属于本次迁移');
    } else {
      if ((await readdir(m.park)).length) throw new Error('迁移目录出现未知文件，停止初始化');
      await writeFile(markerFile, JSON.stringify({ owner: 'SuperBaodan', version: 1, migration: { manifest: file, state: 'copying' } }), { flag: 'wx' });
    }
  }
  const layout = await prepareWorkspace(m.root, { allowMigration: true });
  const marker = JSON.parse(await readFile(layout.markerFile, 'utf8'));
  if (marker.migration && marker.migration.manifest !== file) throw new Error('目标属于另一项迁移');
  // Record the generated neutral prompt before replacement; only this exact copy may be removed.
  if (!m.generatedPrompt) { m.generatedPrompt = { size: Buffer.byteLength(DEFAULT_PROJECT_PROMPT), hash: hash(DEFAULT_PROJECT_PROMPT) }; await json(file, m); }
  marker.migration = { manifest: file, state: 'copying' };
  await json(layout.markerFile, marker);
  m.state = 'copying'; await json(file, m);
  for (const item of m.files) {
    await assertManagedPath(layout, item.target, { file: true });
    const exists = await lstat(item.target).catch(absent);
    if (exists) {
      const current = await digest(item.target);
      if (current.hash === item.hash) continue;
      if (item.target !== layout.projectPromptFile || current.hash !== m.generatedPrompt.hash) throw new Error(`目标冲突：${item.target}`);
      await unlink(item.target);
    }
    await assertManagedPath(layout, path.dirname(item.target), { create: true });
    await copyFile(item.backup, item.target, 1);
    await verify(item.target, item);
  }
  for (const item of m.files) await verify(item.source, item);
  m.state = 'staged'; await json(file, m);
  return m;
}

async function verifyTargets(m) { for (const item of m.files) await verify(item.target, item); }

// validate must use the SDK without a paid model call. Source files are retained
// until every target and SDK resource has passed verification.
export async function commitMigration(file, validate) {
  const m = JSON.parse(await readFile(file, 'utf8'));
  if (m.state === 'complete') { await verifyTargets(m); return m; }
  if (!['staged', 'removing'].includes(m.state)) throw new Error('迁移尚未完成复制校验');
  const layout = await prepareWorkspace(m.root, { allowMigration: true });
  const ownedMarker = JSON.parse(await readFile(layout.markerFile, 'utf8'));
  if (ownedMarker.migration?.manifest !== file) throw new Error('迁移标记归属发生变化');
  await verifyTargets(m);
  if (m.registryFile && hash(await readFile(m.registryFile)) !== m.registryHash) throw new Error('工作区登记发生变化，停止提交');
  if (typeof validate !== 'function') throw new Error('缺少SDK验收回调，不能删除迁移源文件');
  await validate(layout, m);
  for (const item of m.files) {
    if (await lstat(item.source).catch(absent)) { await safeSource(m.root, item.source); await verify(item.source, item); }
    else if (m.state !== 'removing') throw new Error(`迁移源已消失：${item.source}`);
  }
  m.state = 'removing'; await json(file, m);
  for (const item of m.files) {
    await assertManagedPath(layout, item.target, { file: true }); await verify(item.target, item);
    if (await lstat(item.source).catch(absent)) { await safeSource(m.root, item.source); await verify(item.source, item); await unlink(item.source); }
    item.removed = true; await json(file, m);
  }
  for (const dir of [...m.sourceDirectories].sort((a, b) => b.length - a.length)) {
    await rmdir(dir).catch(e => { if (!['ENOTEMPTY', 'ENOENT'].includes(e.code)) throw e; });
  }
  const marker = JSON.parse(await readFile(layout.markerFile, 'utf8'));
  marker.migration = { manifest: file, state: 'complete' }; await json(layout.markerFile, marker);
  m.state = 'complete'; m.completedAt = new Date().toISOString(); await json(file, m);
  return m;
}

export async function rollbackMigration(file) {
  const m = JSON.parse(await readFile(file, 'utf8'));
  if (m.state === 'rolled-back') {
    for (const item of m.files) { await safeSource(m.root, item.source); await verify(item.source, item); }
    return m;
  }
  // Preflight everything before changing any source or target.
  for (const item of m.files) {
    await verify(item.backup, item);
    if (await lstat(item.source).catch(absent)) { await safeSource(m.root, item.source); await verify(item.source, item); }
    if (await lstat(item.target).catch(absent)) await verify(item.target, item);
  }
  const layout = await prepareWorkspace(m.root, { allowMigration: true });
  for (const item of m.files) {
    if (!await lstat(item.source).catch(absent)) {
      // Refuse redirects in existing ancestors before recreating a source directory.
      let parent = path.dirname(item.source);
      while (!await lstat(parent).catch(absent)) parent = path.dirname(parent);
      if (parent !== m.root) await safeSource(m.root, parent);
      await mkdir(path.dirname(item.source), { recursive: true });
      await copyFile(item.backup, item.source, 1);
    }
    await verify(item.source, item);
    if (await lstat(item.target).catch(absent)) { await assertManagedPath(layout, item.target, { file: true }); await verify(item.target, item); await unlink(item.target); }
  }
  m.state = 'rolled-back'; await json(file, m);
  // Keep an explicit rollback marker. A later normal open cannot misreport an
  // incomplete layout as migrated or silently re-create the old managed state.
  const marker = JSON.parse(await readFile(layout.markerFile, 'utf8'));
  marker.migration = { manifest: file, state: 'rolled-back' }; await json(layout.markerFile, marker);
  return m;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [operation, file] = process.argv.slice(2);
  if (operation === 'stage') console.log((await stageMigration(file)).state);
  else if (operation === 'rollback') console.log((await rollbackMigration(file)).state);
  else throw new Error('通过模块接口生成显式迁移清单及SDK验收；CLI仅支持 stage/rollback <migration.json>');
}
