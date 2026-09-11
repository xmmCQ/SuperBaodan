import { spawn } from 'node:child_process';
import path from 'node:path';
import { statusError } from './pi-admin.mjs';

export function openSkillDirectory(directory) {
  if (process.platform !== 'win32') throw statusError(503, '打开技能目录需要 Windows');
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [directory], { shell: false, detached: true, stdio: 'ignore' });
    child.once('error', () => reject(statusError(502, '无法启动文件资源管理器')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
