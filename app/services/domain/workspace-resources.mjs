import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceLayout } from './workspace-layout.mjs';

const fail = message => Object.assign(new Error(message), { statusCode: 409 });
const parse = text => text === undefined ? {} : JSON.parse(text);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function read(file) { try { return readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }

// Conflicts are explicit: there is no implicit "Park wins" policy.
export function combineProjectSettings(user, managed) {
  const result = { ...user };
  for (const [key, value] of Object.entries(managed)) {
    if (key in user && !equal(user[key], value)) throw fail(`用户项目与 BaodanPark 设置冲突：${key}；未选择或覆盖任何一份`);
    result[key] = value;
  }
  return result;
}

function checkManagedFile(layout, file) {
  let current = layout.workspaceRoot;
  for (const part of path.relative(current, file).split(path.sep)) {
    current = path.join(current, part);
    if (!existsSync(current)) {
      try { lstatSync(current); throw fail(`管理路径存在失效链接：${current}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      continue;
    }
    if (lstatSync(current).isSymbolicLink() || path.resolve(realpathSync(current)).toLowerCase() !== path.resolve(current).toLowerCase()) throw fail(`管理路径不能经过链接：${current}`);
  }
}

export function validateWorkspaceSettings(cwd) {
  const layout = workspaceLayout(cwd);
  checkManagedFile(layout, layout.projectSettingsFile);
  const user = parse(read(path.join(cwd, '.pi', 'settings.json')));
  const managed = parse(read(layout.projectSettingsFile));
  for (const key of ['skills', 'extensions', 'prompts', 'themes', 'packages']) {
    if (managed[key]?.length) throw fail(`BaodanPark 的 ${key} 设置需要显式兼容处理，未自动覆盖用户项目配置`);
  }
  return combineProjectSettings(user, managed);
}

export function createWorkspaceSettings(sdk, cwd, agentDir) {
  const layout = workspaceLayout(cwd);
  const userFile = path.join(cwd, '.pi', 'settings.json');
  const globalFile = path.join(agentDir, 'settings.json');
  const readProjects = managed => {
    const user = parse(read(userFile)), park = parse(managed);
    // SDK resolves resource settings against cwd=A. Do not silently reinterpret
    // a Park-relative resource as an A-relative resource.
    for (const key of ['skills', 'extensions', 'prompts', 'themes', 'packages']) {
      if (park[key]?.length) throw fail(`BaodanPark 的 ${key} 设置需要显式兼容处理，未自动覆盖用户项目配置`);
    }
    return { user, combined: combineProjectSettings(user, park) };
  };
  // Fail before SDK's tolerant settings loader can turn a conflict into defaults.
  checkManagedFile(layout, layout.projectSettingsFile);
  readProjects(read(layout.projectSettingsFile));
  const storage = {
    withLock(scope, fn) {
      const file = scope === 'global' ? globalFile : layout.projectSettingsFile;
      if (scope === 'project') checkManagedFile(layout, file);
      const current = read(file);
      const project = scope === 'project' ? readProjects(current) : null;
      const next = fn(project ? JSON.stringify(project.combined) : current);
      if (next === undefined) return;
      let output = next;
      if (project) {
        const changed = parse(next);
        for (const [key, value] of Object.entries(project.user)) {
          if (!equal(changed[key], value)) throw fail(`不能通过宝蛋设置覆盖用户项目字段：${key}`);
          delete changed[key];
        }
        output = JSON.stringify(changed, null, 2);
      }
      mkdirSync(path.dirname(file), { recursive: true });
      // Same lock-directory convention as the SDK; never break another writer's lock.
      const lock = `${file}.lock`, temp = `${file}.${randomUUID()}.tmp`;
      mkdirSync(lock);
      try {
        if (read(file) !== current) throw fail('设置在保存期间发生变化，请重试');
        if (project && !equal(parse(read(userFile)), project.user)) throw fail('用户项目设置已变化，请重试');
        if (scope === 'project') checkManagedFile(layout, file);
        writeFileSync(temp, output, { flag: 'wx' });
        renameSync(temp, file);
      } finally { if (existsSync(temp)) unlinkSync(temp); rmdirSync(lock); }
    },
  };
  return sdk.SettingsManager.fromStorage(storage, { projectTrusted: true });
}

export function workspaceResourceOptions(layout) {
  return {
    additionalSkillPaths: [layout.projectSkillRoot],
    agentsFilesOverride: base => {
      checkManagedFile(layout, layout.projectPromptFile);
      return { agentsFiles: [
        ...base.agentsFiles.filter(item => path.resolve(item.path) !== layout.projectPromptFile),
        { path: layout.projectPromptFile, content: readFileSync(layout.projectPromptFile, 'utf8') },
      ] };
    },
  };
}
