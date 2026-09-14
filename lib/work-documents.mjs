import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pickWorkDocument } from './pick-work-document.mjs';
import { recycleWorkDocument } from './recycle-work-document.mjs';
import { emptyDocuments, validateDocuments, normalizeTarget, MAX_BYTES, fail } from '../public/core/work-documents.js';
const hash = text => createHash('sha256').update(text).digest('hex');
export function launchWorkDocument(file) {
  if (process.platform !== 'win32') throw fail('打开本地文档需要 Windows', 503);
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [file], { shell: false, detached: true, stdio: 'ignore' });
    child.once('error', () => reject(fail('无法调用系统打开文档', 502)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
export class WorkDocuments {
  constructor({ filePath, launch = launchWorkDocument, pick = pickWorkDocument, recycle = recycleWorkDocument }) { this.filePath = filePath; this.launch = launch; this.pick = pick; this.recycle = recycle; this.picking = false; this.queue = Promise.resolve(); this.opening = new Set(); }
  async read() {
    let raw;
    try { if ((await fs.stat(this.filePath)).size > MAX_BYTES) throw fail('工作文档配置过大，未覆盖原文件', 409); raw = await fs.readFile(this.filePath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; raw = JSON.stringify(emptyDocuments()); }
    let data;
    try { data = validateDocuments(JSON.parse(raw)); } catch { throw fail('工作文档配置损坏，未覆盖原文件；可从 work-documents.json.bak 恢复', 409); }
    return { ...data, revision: hash(raw) };
  }
  enqueue(operation) { const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result; }
  save(body) {
    return this.enqueue(async () => {
      const current = await this.read();
      if (!body?.revision || body.revision !== current.revision) throw fail('目录已被其他页面修改；请重新读取后重试，当前草稿已保留', 409);
      return this.writeData(validateDocuments(body));
    });
  }
  async writeData(data, beforeCommit = async () => {}) {
      const raw = JSON.stringify(data, null, 2);
      if (Buffer.byteLength(raw) > MAX_BYTES) throw fail('目录配置不能超过1 MiB', 413);
      const temp = `${this.filePath}.${randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      try { await fs.copyFile(this.filePath, `${this.filePath}.bak`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await fs.writeFile(temp, raw, { encoding: 'utf8', flag: 'wx' }); await beforeCommit(); await fs.rename(temp, this.filePath); }
      catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); throw error; }
      return { ...data, revision: hash(raw) };
  }
  remove(body) {
    return this.enqueue(async () => {
      if (!body || typeof body.id !== 'string' || typeof body.revision !== 'string' || typeof body.recycleSource !== 'boolean') throw fail('缺少删除参数');
      const current = await this.read();
      if (current.revision !== body.revision) throw fail('目录已变化，请重新读取后再删除', 409);
      const doc = current.documents.find(d => d.id === body.id);
      if (!doc) throw fail('文档入口已删除，请重新读取', 404);
      let target = null;
      if (body.recycleSource && doc.kind === 'file') {
        target = normalizeTarget('file', doc.target);
        try {
          const stat = await fs.lstat(target);
          if (!stat.isFile() || stat.isSymbolicLink()) throw fail('仅支持普通文件移入回收站，入口已保留');
          const real = await fs.realpath(target);
          // Windows short (8.3) names legitimately differ from realpath.
          // Reject symlink/junction ancestors explicitly instead of string comparison.
          for (let parent = path.dirname(target); parent !== path.dirname(parent); parent = path.dirname(parent)) {
            if ((await fs.lstat(parent)).isSymbolicLink()) throw fail('不支持通过链接路径删除源文件，入口已保留');
          }
          target = real;
          if ([this.filePath, `${this.filePath}.bak`].some(file => path.resolve(file).toLowerCase() === path.resolve(real).toLowerCase())) throw fail('不能删除工作文档目录配置自身');
        } catch (error) { if (error.statusCode) throw error; throw fail('源文件不存在或无法访问，入口已保留；可取消勾选后仅删除入口', 409); }
      }
      const next = validateDocuments({ ...current, documents: current.documents.filter(d => d.id !== doc.id) });
      let recycled = false;
      try {
        const data = await this.writeData(next, async () => { if (target) { await this.recycle(target); recycled = true; } });
        return { ...data, recycled, message: recycled ? '入口已删除，源文件已移入回收站' : '入口已删除，源文件不受影响' };
      } catch (error) {
        if (recycled) throw fail('源文件已移入回收站，但目录更新失败；请重新读取目录，不要重复删除源文件', 500);
        throw error;
      }
    });
  }
  async chooseFile(options = {}) {
    if (this.picking) throw fail('已有文件选择窗口，请先完成或取消选择', 409);
    this.picking = true;
    const controller = new AbortController(); this.pickerController = controller;
    const cancel = () => controller.abort();
    if (options.signal?.aborted) cancel();
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (controller.signal.aborted) throw fail('已取消文件选择', 499);
      const result = await this.pick({ signal: controller.signal });
      if (controller.signal.aborted) throw fail('已取消文件选择', 499);
      if (result.cancelled) return { cancelled: true };
      const target = normalizeTarget('file', result.path);
      let real;
      try { real = await fs.realpath(target); if (!(await fs.stat(real)).isFile()) throw new Error('not file'); }
      catch { throw fail('所选文件不存在或无法访问，请重新选择', 404); }
      normalizeTarget('file', real);
      return { cancelled: false, path: target, name: path.win32.basename(target) };
    } finally { options.signal?.removeEventListener('abort', cancel); this.pickerController = null; this.picking = false; }
  }
  cancelPicker() { this.pickerController?.abort(); }
  async open(body) {
    if (!body || typeof body.id !== 'string' || typeof body.revision !== 'string') throw fail('缺少文档标识或目录版本');
    if (this.opening.has(body.id)) throw fail('正在打开，请稍候', 409);
    this.opening.add(body.id);
    try {
      return await this.enqueue(async () => {
        const current = await this.read();
        if (body.revision !== current.revision) throw fail('目录已变化，请重新读取后再打开', 409);
        const doc = current.documents.find(item => item.id === body.id);
        if (!doc) throw fail('文档入口已删除，请重新读取', 404);
        if (doc.kind !== 'file') throw fail('在线文档请使用浏览器链接打开');
        let real;
        try { real = await fs.realpath(doc.target); if (!(await fs.stat(real)).isFile()) throw fail('目标不是普通文件'); }
        catch (error) { if (error.statusCode) throw error; throw fail(error.code === 'EACCES' || error.code === 'EPERM' ? '没有权限访问该文档' : '文件不存在或不可访问，请编辑路径修复', 404); }
        normalizeTarget('file', real);
        await this.launch(real);
        return { ok: true, opened: true, message: '已交给系统打开' };
      });
    } finally { this.opening.delete(body.id); }
  }
}
