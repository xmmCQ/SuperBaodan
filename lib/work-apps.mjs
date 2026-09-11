import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const revision = text => createHash('sha256').update(text).digest('hex');
export function defaultWorkApps(home = process.env.USERPROFILE || os.homedir()) {
  return [
    { id: 'yuque', name: '语雀', path: path.win32.join(home, 'AppData/Local/Programs/yuque-desktop/语雀.exe'), enabled: true, processes: ['语雀', 'Yuque'] },
    { id: 'weixin', name: '微信', path: 'D:\\Program Files\\Tencent\\Weixin\\Weixin.exe', enabled: true, processes: ['Weixin'] },
    { id: 'dingtalk', name: '钉钉', path: 'C:\\Program Files (x86)\\DingDing\\DingtalkLauncher.exe', enabled: true, processes: ['DingTalk', 'DingtalkLauncher'] },
  ];
}
export function validateWorkApps(apps) {
  if (!Array.isArray(apps) || apps.length > 20) throw fail('最多配置20个软件');
  const ids = new Set();
  return apps.map(app => {
    if (!app || typeof app.id !== 'string' || !/^[\w-]{1,64}$/.test(app.id) || ids.has(app.id)) throw fail('软件标识无效或重复');
    ids.add(app.id);
    if (typeof app.name !== 'string' || !app.name.trim() || app.name.length > 40) throw fail('软件名称需为1～40个字符');
    if (typeof app.path !== 'string') throw fail('请填写软件完整路径');
    let target = app.path.trim(); if (target.startsWith('"') && target.endsWith('"')) target = target.slice(1, -1);
    target = target.replaceAll('/', '\\');
    if (target.length > 512 || !/^[a-z]:\\/i.test(target) || /[<>"|?*\x00-\x1f:]/.test(target.slice(2)) || !/\.(exe|lnk)$/i.test(target)) throw fail('仅支持本机 .exe 或 .lnk 完整路径，不支持命令参数');
    if (typeof app.enabled !== 'boolean') throw fail('启用状态不正确');
    const processes = app.processes || [];
    if (!Array.isArray(processes) || processes.length > 4 || processes.some(p => typeof p !== 'string' || !/^[\p{L}\p{N}_. -]{1,80}$/u.test(p))) throw fail('进程名称不正确');
    return { id: app.id, name: app.name.trim(), path: path.win32.normalize(target), enabled: app.enabled, processes };
  });
}
export class WorkApps {
  constructor({ filePath, launch, defaults = defaultWorkApps() }) { this.filePath = filePath; this.launch = launch; this.defaults = defaults; this.queue = Promise.resolve(); this.launching = false; }
  async read() {
    let text;
    try { if ((await fs.stat(this.filePath)).size > 65536) throw fail('软件配置文件过大，请检查文件', 409); text = await fs.readFile(this.filePath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; text = JSON.stringify({ version: 1, apps: this.defaults }); }
    let data;
    try { data = JSON.parse(text); if (data.version !== 1) throw Error(); data.apps = validateWorkApps(data.apps); }
    catch { throw fail('软件配置文件无效，请检查 work-apps.json；未覆盖原文件', 409); }
    return { apps: data.apps, revision: revision(text) };
  }
  save(body) {
    const work = this.queue.then(async () => {
      const current = await this.read();
      if (!body?.revision || body.revision !== current.revision) throw fail('软件配置已变化，请重新打开管理窗口后再保存', 409);
      const apps = validateWorkApps(body.apps);
      for (const app of apps) {
        const previous = current.apps.find(item => item.id === app.id);
        // Preserve launcher aliases only when the configured executable is unchanged.
        app.processes = previous?.path.toLowerCase() === app.path.toLowerCase() ? previous.processes : [];
      }
      const text = JSON.stringify({ version: 1, apps }, null, 2), temp = `${this.filePath}.tmp`;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      try { await fs.copyFile(this.filePath, `${this.filePath}.bak`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      try { await fs.writeFile(temp, text, 'utf8'); await fs.rename(temp, this.filePath); }
      catch (e) { await fs.unlink(temp).catch(() => {}); throw e; }
      return { apps, revision: revision(text) };
    });
    this.queue = work.catch(() => {}); return work;
  }
  async run(id = null, expectedRevision = null) {
    if (this.launching) throw fail('工作软件正在启动，请稍候', 409);
    this.launching = true;
    try {
      await this.queue;
      const current = await this.read();
      if (expectedRevision && current.revision !== expectedRevision) throw fail('软件配置已变化，请重新打开管理窗口', 409);
      const apps = id ? current.apps.filter(app => app.id === id) : current.apps.filter(app => app.enabled);
      if (id && !apps.length) throw fail('软件已删除，请重新打开管理窗口', 404);
      return apps.length ? await this.launch(apps) : { results: [], warning: '没有启用的软件，请先在管理软件中配置' };
    } finally { this.launching = false; }
  }
}
