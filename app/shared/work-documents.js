import { fault } from './errors.js';
export const UNCATEGORIZED = 'uncategorized';
export const MAX_BYTES = 1024 * 1024;
export const FILE_EXTENSIONS = /\.(docx?|xlsx?|pptx?|pdf|txt|md|csv|rtf|wps|et|dps|png|jpe?g|webp)$/i;
export const fail = (message, statusCode = 400) => fault(statusCode, message);
export const emptyDocuments = () => ({ version: 1, categories: [{ id: UNCATEGORIZED, name: '未分类' }], documents: [] });
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw fail(`${label}不能为空，且不超过${max}字`);
  return value.trim();
};
export function normalizeTarget(kind, value) {
  let target = text(value, kind === 'file' ? 1026 : 2048, '地址');
  if (kind === 'url') {
    let url; try { url = new URL(target); } catch { throw fail('请输入完整 HTTP/HTTPS 网址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('仅支持不含账号密码的 HTTP/HTTPS 网址');
    if (url.href.length > 2048) throw fail('网址不能超过2048字符');
    return url.href;
  }
  if (kind !== 'file') throw fail('文档类型无效');
  if (target.startsWith('"') && target.endsWith('"')) target = target.slice(1, -1);
  target = target.replaceAll('/', '\\');
  if (target.length > 1024 || !/^[a-z]:\\/i.test(target) || /[<>"|?*\x00-\x1f:]/.test(target.slice(2)) || /%[^%]+%/.test(target)) throw fail('仅支持本机盘符绝对路径，不支持参数、网络路径或环境变量');
  const parts = [];
  for (const part of target.slice(3).split('\\')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw fail('文件路径越界'); parts.pop(); continue; }
    if (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw fail('文件路径包含 Windows 保留名称或无效结尾');
    parts.push(part);
  }
  target = target[0].toUpperCase() + ':\\' + parts.join('\\');
  if (!FILE_EXTENSIONS.test(target)) throw fail('不支持此文件类型；请选择办公文档、PDF、文本或常见图片');
  return target;
}
export const targetKey = item => `${item.categoryId}\0${item.kind}\0${item.kind === 'file' ? item.target.toLowerCase() : item.target}`;
export function validateDocuments(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.categories) || !Array.isArray(data.documents)) throw fail('工作文档配置格式无效');
  if (data.categories.length > 51 || data.documents.length > 500) throw fail('最多50个自定义分类、500个文档入口');
  const ids = new Set(), names = new Set();
  const id = value => { if (typeof value !== 'string' || !/^[\w-]{1,64}$/.test(value) || ids.has(value)) throw fail('标识无效或重复'); ids.add(value); return value; };
  const categories = data.categories.map(c => {
    const name = text(c?.name, 40, '分类名称');
    if (c.id === 'all' || name === '全部') throw fail('“全部”为保留分类');
    if (names.has(name)) throw fail('分类名称重复'); names.add(name);
    return { id: id(c.id), name };
  });
  if (!categories.some(c => c.id === UNCATEGORIZED && c.name === '未分类')) throw fail('必须保留“未分类”分类');
  const categoryIds = new Set(categories.map(c => c.id)), targets = new Set();
  const documents = data.documents.map(d => {
    if (!d || !categoryIds.has(d.categoryId)) throw fail('文档分类不存在');
    const item = { id: id(d.id), categoryId: d.categoryId, name: text(d.name, 100, '文档名称'), kind: d.kind, target: normalizeTarget(d.kind, d.target) };
    const key = targetKey(item); if (targets.has(key)) throw fail('同一分类已有该文档入口'); targets.add(key); return item;
  });
  const result = { version: 1, categories, documents };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_BYTES) throw fail('目录配置不能超过1 MiB', 413);
  return result;
}
export function moveItem(items, id, direction, predicate = () => true) {
  const indices = items.map((item, i) => predicate(item) ? i : -1).filter(i => i >= 0);
  const position = indices.findIndex(i => items[i].id === id), next = position + direction;
  if (position < 0 || next < 0 || next >= indices.length) return;
  const a = indices[position], b = indices[next]; [items[a], items[b]] = [items[b], items[a]];
}
