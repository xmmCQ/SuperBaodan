import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { statusError } from './pi-admin.mjs';

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export class SkillDirectoryCache {
  constructor() { this.entries = new Map(); this.sequence = 0; }
  begin() { return ++this.sequence; }
  clear() { this.sequence++; this.entries.clear(); }
  async publish(skills, sequence) {
    const entries = new Map();
    for (const skill of skills) {
      try {
        const [directory, file] = await Promise.all([realpath(path.dirname(skill.filePath)), realpath(skill.filePath)]);
        entries.set(skill.id, { filePath: skill.filePath, directory, file });
      } catch { /* Disappeared during listing: never register a stale path. */ }
    }
    if (sequence === this.sequence) this.entries = entries;
  }
  async resolve(id) {
    const entry = this.entries.get(id);
    if (!entry) throw statusError(404, 'Skill 已变化，请刷新技能列表后重试');
    try {
      const [directory, file] = await Promise.all([realpath(path.dirname(entry.filePath)), realpath(entry.filePath)]);
      if (!samePath(directory, entry.directory) || !samePath(file, entry.file)) throw statusError(409, 'Skill 路径已变化，请刷新技能列表后重试');
      const [dirStat, fileStat] = await Promise.all([lstat(directory), lstat(file)]);
      if (!dirStat.isDirectory() || !fileStat.isFile()) throw statusError(409, 'Skill 路径无效，请刷新技能列表后重试');
      if (this.entries.get(id) !== entry) throw statusError(409, 'Skill 列表已变化，请重试');
      return directory;
    } catch (error) {
      if (this.entries.get(id) === entry) this.entries.delete(id);
      if (error.statusCode) throw error;
      throw statusError(404, 'Skill 目录或文件不存在，请刷新技能列表后重试');
    }
  }
}
