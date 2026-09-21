import { UNCATEGORIZED, normalizeTarget, validateDocuments, targetKey, MAX_BYTES, fail } from './work-documents.js';
export function checkImportRow(row) {
  const name = String(row.name || '').trim(), category = String(row.category || '').trim() || '未分类';
  if (!name || name.length > 100 || /[\x00-\x1f]/.test(name)) throw fail('名称需为1～100字');
  if (category.length > 40 || /[\x00-\x1f]/.test(category)) throw fail('分类名称不能超过40字');
  return { name, category, kind: row.kind, target: normalizeTarget(row.kind, row.target) };
}
export function parseDocumentMarkdown(markdown) {
  if (new TextEncoder().encode(markdown).length > MAX_BYTES) throw fail('Markdown 不能超过1 MiB', 413);
  const rows = []; let category = '未分类', fence = null;
  for (const [index, original] of markdown.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const marker = original.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null; continue; }
    if (fence || /^( {4}|\t)/.test(original)) continue;
    const heading = original.match(/^ {0,3}#\s+(.+?)\s*#*\s*$/);
    if (heading) { category = heading[1].trim(); continue; }
    if (/^ {0,3}#{2,6}\s/.test(original)) continue;
    const line = original.replace(/(`+)[\s\S]*?\1/g, '');
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '[' || line[i - 1] === '!' || line[i - 1] === '[' || line[i + 1] === '[') continue;
      const end = line.indexOf('](', i + 1); if (end < 0) continue;
      const name = line.slice(i + 1, end).replace(/\\([\[\]])/g, '$1');
      let at = end + 2, target = '', depth = 1;
      if (line[at] === '<') {
        const close = line.indexOf('>', at + 1);
        if (close >= 0 && /^\s*\)/.test(line.slice(close + 1))) { target = line.slice(at + 1, close); at = close + 1 + line.slice(close + 1).indexOf(')'); depth = 0; }
      } else {
        const start = at;
        for (; at < line.length; at++) { if (line[at] === '(') depth++; if (line[at] === ')' && --depth === 0) break; }
        target = line.slice(start, at).trim();
      }
      const row = { name, category, target, kind: /^https?:/i.test(target) ? 'url' : 'file', line: index + 1 };
      try { if (depth) throw fail('链接未闭合或格式不支持'); Object.assign(row, checkImportRow(row)); row.selected = true; }
      catch (error) { row.error = error.message; row.selected = false; }
      rows.push(row); i = at;
      if (rows.length > 1000) throw fail('导入链接过多，请拆分 Markdown 文件', 413);
    }
  }
  return rows;
}
export function mergeDocumentImport(current, rows, makeId = () => crypto.randomUUID()) {
  const data = structuredClone(validateDocuments(current));
  const names = new Map(data.categories.map(c => [c.name, c.id])), keys = new Set(data.documents.map(targetKey));
  let added = 0, duplicates = 0, invalid = 0;
  for (const row of rows) {
    if (!row.selected) { try { checkImportRow(row); } catch { invalid++; } continue; }
    const item = checkImportRow(row);
    let categoryId = names.get(item.category);
    if (!categoryId) { categoryId = makeId(); names.set(item.category, categoryId); data.categories.push({ id: categoryId, name: item.category }); }
    const document = { id: makeId(), categoryId: categoryId || UNCATEGORIZED, name: item.name, kind: item.kind, target: item.target };
    const key = targetKey(document); if (keys.has(key)) { duplicates++; continue; }
    keys.add(key); data.documents.push(document); added++;
  }
  return { data: validateDocuments(data), added, duplicates, invalid };
}
