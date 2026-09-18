import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PARK_NAME = 'BaodanPark';
export const LAYOUT_VERSION = 1;
export const DEFAULT_PROJECT_PROMPT = '# 工作区指令\n\n遵循用户要求，保护已有文件；涉及覆盖或删除时先确认。\n';
const OWNER = 'SuperBaodan';
const fail = message => Object.assign(new Error(message), { statusCode: 409 });
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const missing = error => { if (error.code === 'ENOENT') return null; throw error; };
const preparations = new Map();

export function workspaceLayout(workspaceRoot, sessionId) {
  const root = path.resolve(workspaceRoot), parkRoot = path.join(root, PARK_NAME);
  const result = {
    workspaceRoot: root, parkRoot, defaultDeliveryRoot: root,
    markerFile: path.join(parkRoot, '.baodan.json'),
    projectPromptFile: path.join(parkRoot, 'AGENTS.md'),
    projectSkillRoot: path.join(parkRoot, '.pi', 'skills'),
    projectSkillLockFile: path.join(parkRoot, 'skills-lock.json'),
    projectSettingsFile: path.join(parkRoot, '.pi', 'settings.json'),
    cacheRoot: path.join(parkRoot, 'cache'),
  };
  if (sessionId !== undefined) {
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw fail('会话标识无效，无法准备临时目录');
    result.sessionScratchRoot = path.join(parkRoot, 'tmp', sessionId);
    result.scratchScriptsDir = path.join(result.sessionScratchRoot, 'scripts');
    result.intermediateDir = path.join(result.sessionScratchRoot, 'intermediate');
  }
  return Object.freeze(result);
}

export async function assertManagedPath(layout, candidate, { file = false, create = false } = {}) {
  const relative = path.relative(layout.workspaceRoot, path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw fail('管理路径越出工作区');
  let current = layout.workspaceRoot;
  const parts = relative.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let info = await lstat(current).catch(missing);
    const isFile = file && i === parts.length - 1;
    if (!info && create && !isFile) {
      await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
      info = await lstat(current);
    }
    if (!info) continue;
    if (info.isSymbolicLink() || !same(await realpath(current), current)) throw fail(`管理路径不能经过链接或 junction：${current}`);
    if (isFile ? !info.isFile() : !info.isDirectory()) throw fail(`管理路径类型冲突：${current}`);
  }
}

export async function assertNotInsidePark(root) {
  for (let current = root; ; current = path.dirname(current)) {
    const marker = path.join(current, '.baodan.json');
    const info = await lstat(marker).catch(missing);
    if (info) {
      if (info.isSymbolicLink() || !info.isFile()) throw fail(`异常管理标记：${marker}`);
      const value = JSON.parse(await readFile(marker, 'utf8'));
      if (value.owner === OWNER) throw fail(`请选择所属工作区 ${path.dirname(current)}，不能选择 BaodanPark 或其内部目录`);
    }
    if (path.dirname(current) === current) break;
  }
}

export async function prepareWorkspace(root, { sessionId, allowMigration = false } = {}) {
  const canonical = await realpath(root);
  if (!(await lstat(canonical)).isDirectory()) throw fail('工作区不是目录');
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const previous = preparations.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => prepare(canonical, sessionId, allowMigration));
  preparations.set(key, operation);
  try { return await operation; }
  finally { if (preparations.get(key) === operation) preparations.delete(key); }
}

async function prepare(root, sessionId, allowMigration) {
  await assertNotInsidePark(root);
  const layout = workspaceLayout(root, sessionId);
  await assertManagedPath(layout, layout.parkRoot);
  let info = await lstat(layout.parkRoot).catch(missing);
  if (!info) { await mkdir(layout.parkRoot); info = await lstat(layout.parkRoot); }
  await assertManagedPath(layout, layout.markerFile, { file: true });
  const markerInfo = await lstat(layout.markerFile).catch(missing);
  if (!markerInfo) {
    if ((await readdir(layout.parkRoot)).length) throw fail('BaodanPark 为未标记的非空目录，不能自动接管');
    await writeFile(layout.markerFile, JSON.stringify({ owner: OWNER, version: LAYOUT_VERSION, migration: null }, null, 2) + '\n', { flag: 'wx' });
  }
  const marker = JSON.parse(await readFile(layout.markerFile, 'utf8'));
  if (marker.owner !== OWNER || marker.version !== LAYOUT_VERSION) throw fail('BaodanPark 归属或结构版本不兼容，未修改目录');
  if (marker.migration && marker.migration.state !== 'complete' && !allowMigration) throw fail('工作区迁移尚未完成，请先恢复迁移或回滚');
  for (const dir of [layout.projectSkillRoot, layout.cacheRoot, path.join(layout.parkRoot, 'tmp'), path.join(layout.parkRoot, '.agents')]) {
    await assertManagedPath(layout, dir, { create: !dir.endsWith('.agents') });
  }
  for (const file of [layout.projectPromptFile, layout.projectSkillLockFile, layout.projectSettingsFile]) await assertManagedPath(layout, file, { file: true });
  // Check known third-party paths too; never follow a pre-existing redirect.
  await assertManagedPath(layout, path.join(layout.parkRoot, '.agents', 'skills'));
  try { await writeFile(layout.projectPromptFile, DEFAULT_PROJECT_PROMPT, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (layout.sessionScratchRoot) {
    await assertManagedPath(layout, layout.scratchScriptsDir, { create: true });
    await assertManagedPath(layout, layout.intermediateDir, { create: true });
  }
  const probe = path.join(layout.parkRoot, `.write-check-${randomUUID()}`);
  await writeFile(probe, '', { flag: 'wx' });
  await unlink(probe);
  return layout;
}

export function workspaceLayoutPrompt(layout) {
  return [
    '## 宝蛋工作区目录约定（不是文件系统沙箱）',
    `用户工作区与默认交付目录：${layout.workspaceRoot}`,
    `一次性辅助脚本：${layout.scratchScriptsDir}`,
    `中间数据：${layout.intermediateDir}`,
    '用户指定输出位置时遵从用户要求。正式项目源码在原位置修改，不按扩展名搬入过程目录。',
    '运行临时脚本时使用明确完整路径；使用唯一文件名，不能静默覆盖已有过程文件或成品。',
    '普通问答不创建脚本，不预读或汇总历史缓存，不自动删除过程文件。',
  ].join('\n');
}
