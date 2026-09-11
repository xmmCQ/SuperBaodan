import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const LIMIT = 128 * 1024;
export async function readProjectPrompt(root) {
  const directory = await fs.realpath(root), file = path.join(directory, 'AGENTS.md');
  let bytes;
  try {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw fail('AGENTS.md 必须是项目根目录中的普通文件，不能是链接', 409);
    if (info.size > LIMIT) throw fail('项目提示词超过128KB，请使用外部编辑器处理', 413);
    bytes = await fs.readFile(file);
  } catch (e) { if (e.code === 'ENOENT') return { path: file, exists: false, content: '', revision: 'missing' }; throw e; }
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('AGENTS.md 不是有效UTF-8文本，请先转换编码', 409); }
  return { path: file, exists: true, content, revision: createHash('sha256').update(bytes).digest('hex') };
}
export async function saveProjectPrompt(root, body, backupDir) {
  if (typeof body.content !== 'string' || Buffer.byteLength(body.content, 'utf8') > LIMIT || body.content.includes('\0')) throw fail('项目提示词需为UTF-8文本，且不超过128KB');
  const original = await readProjectPrompt(root);
  if (!body.revision || body.revision !== original.revision) throw fail('AGENTS.md 已被其他位置修改，请重新读取后再保存', 409);
  if (original.exists) {
    await fs.mkdir(backupDir, { recursive: true });
    const key = createHash('sha256').update(original.path.toLowerCase()).digest('hex').slice(0, 16);
    await fs.copyFile(original.path, path.join(backupDir, `project-prompt-${key}.md.bak`));
  }
  const temp = path.join(path.dirname(original.path), `.AGENTS-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, body.content, { encoding: 'utf8', flag: 'wx' });
    if ((await readProjectPrompt(root)).revision !== original.revision) throw fail('AGENTS.md 已变化，未覆盖，请重新读取', 409);
    await fs.rename(temp, original.path);
  } finally { await fs.unlink(temp).catch(() => {}); }
  return readProjectPrompt(root);
}
