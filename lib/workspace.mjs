import { lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_BINARY_PREVIEW_BYTES = 12 * 1024 * 1024;
export const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 50;
const MAX_TREE_ENTRIES = 1_000;
const MAX_SEARCH_RESULTS = 100;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".jsonl", ".jsonc",
  ".css", ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".ini", ".conf", ".env", ".csv", ".log",
  ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd", ".py", ".rb", ".php", ".java", ".c", ".h", ".cpp",
  ".hpp", ".cs", ".go", ".rs", ".sql", ".vue", ".svelte",
]);
const IMAGE_MIME = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"],
  [".webp", "image/webp"], [".bmp", "image/bmp"],
]);

export class WorkspaceService {
  constructor(root) {
    this.root = path.resolve(root);
    this.rootReal = null;
  }

  async initialize() {
    this.rootReal = await realpath(this.root);
    return this;
  }

  async resolveExisting(relativePath = "", expected = null) {
    const candidate = resolveLexically(this.root, relativePath);
    const resolved = await realpath(candidate).catch((error) => {
      if (error.code === "ENOENT") throw workspaceError(404, "文件或目录不存在");
      throw error;
    });
    const rootReal = this.rootReal || await realpath(this.root);
    assertInside(resolved, rootReal);
    const info = await stat(resolved);
    if (expected === "file" && !info.isFile()) throw workspaceError(400, "请求的路径不是文件");
    if (expected === "directory" && !info.isDirectory()) throw workspaceError(400, "请求的路径不是目录");
    return { absolute: resolved, relative: toRelative(rootReal, resolved), stat: info };
  }

  async normalizeToolPath(input) {
    if (typeof input !== "string" || !input.trim() || input.includes("\0")) return null;
    const rootReal = this.rootReal || await realpath(this.root);
    const raw = input.trim();
    const candidate = path.isAbsolute(raw) || path.win32.isAbsolute(raw)
      ? path.resolve(raw)
      : resolveLexically(this.root, raw);
    assertInside(candidate, this.root);
    let ancestor = candidate;
    while (true) {
      try {
        const ancestorReal = await realpath(ancestor);
        assertInside(ancestorReal, rootReal);
        const suffix = path.relative(ancestor, candidate);
        const finalPath = path.resolve(ancestorReal, suffix);
        assertInside(finalPath, rootReal);
        return toRelative(rootReal, finalPath);
      } catch (error) {
        if (error.statusCode) throw error;
        if (error.code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return null;
        ancestor = parent;
      }
    }
  }

  async tree(relativePath = "", depth = 3) {
    const root = await this.resolveExisting(relativePath, "directory");
    const maxDepth = Math.max(1, Math.min(6, Number(depth) || 3));
    let count = 0;
    const visit = async (absolute, level) => {
      const entries = [];
      const children = await readdir(absolute, { withFileTypes: true });
      children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const child of children) {
        if (++count > MAX_TREE_ENTRIES) break;
        const full = path.join(absolute, child.name);
        const relative = toRelative(this.rootReal, full);
        if (child.isSymbolicLink()) {
          let safe = false;
          try { assertInside(await realpath(full), this.rootReal); safe = true; } catch {}
          entries.push({ name: child.name, path: relative, kind: "symlink", safe });
        } else if (child.isDirectory()) {
          const entry = { name: child.name, path: relative, kind: "directory" };
          if (level < maxDepth) entry.children = await visit(full, level + 1);
          entries.push(entry);
        } else if (child.isFile()) {
          const info = await lstat(full);
          entries.push({ name: child.name, path: relative, kind: "file", size: info.size, previewable: Boolean(previewType(full, info.size)) });
        }
      }
      return entries;
    };
    return { path: root.relative, entries: await visit(root.absolute, 1), truncated: count > MAX_TREE_ENTRIES };
  }

  async search(query) {
    const needle = String(query || "").trim().toLocaleLowerCase();
    if (!needle) return [];
    if (needle.length > 200) throw workspaceError(400, "搜索内容过长");
    const results = [];
    const queue = [this.rootReal || await realpath(this.root)];
    let inspected = 0;
    while (queue.length && results.length < MAX_SEARCH_RESULTS && inspected < MAX_TREE_ENTRIES * 5) {
      const directory = queue.shift();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        inspected += 1;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) queue.push(full);
        else if (entry.isFile() && entry.name.toLocaleLowerCase().includes(needle)) {
          const info = await lstat(full);
          results.push({ name: entry.name, path: toRelative(this.rootReal, full), size: info.size, previewable: Boolean(previewType(full, info.size)) });
          if (results.length >= MAX_SEARCH_RESULTS) break;
        }
      }
    }
    return results;
  }

  async checkUpload(relativeDirectory = "", files = []) {
    const directory = await this.resolveExisting(relativeDirectory, "directory");
    const normalized = validateUploadFiles(files);
    const conflicts = [];
    for (const file of normalized) {
      const target = resolveLexically(directory.absolute, file.name);
      const existing = await lstat(target).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing) conflicts.push({ name: file.name, kind: existing.isSymbolicLink() ? "symlink" : existing.isDirectory() ? "directory" : "file" });
    }
    return { directory: directory.relative, conflicts };
  }

  async upload(relativeDirectory = "", name, content, { overwrite = false } = {}) {
    const directory = await this.resolveExisting(relativeDirectory, "directory");
    const [file] = validateUploadFiles([{ name, size: content?.length }]);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || []);
    const target = resolveLexically(directory.absolute, file.name);
    const existing = await lstat(target).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing?.isSymbolicLink()) throw workspaceError(403, "禁止覆盖符号链接");
    if (existing?.isDirectory()) throw workspaceError(409, "同名目录已存在");
    if (existing && !overwrite) throw workspaceError(409, "同名文件已存在");
    await writeFile(target, buffer, { flag: overwrite ? "w" : "wx", mode: 0o600 });
    const info = await lstat(target);
    const relative = toRelative(this.rootReal, target);
    return { name: file.name, path: relative, size: info.size, previewable: Boolean(previewType(target, info.size)), overwritten: Boolean(existing) };
  }

  async preview(relativePath) {
    const file = await this.resolveExisting(relativePath, "file");
    const type = previewType(file.absolute, file.stat.size);
    if (!type) throw workspaceError(415, "此文件类型不允许预览，或文件超过大小限制");
    if (["text", "code", "markdown"].includes(type.kind)) {
      const buffer = await readFile(file.absolute);
      if (buffer.length > MAX_TEXT_PREVIEW_BYTES) throw workspaceError(413, "文件在读取期间超过文本预览大小限制");
      const content = buffer.toString("utf8");
      if (content.includes("\0")) throw workspaceError(415, "检测到二进制内容，不能作为文本预览");
      return { path: file.relative, size: buffer.length, ...type, content };
    }
    return { path: file.relative, size: file.stat.size, ...type, contentUrl: `/api/workspace/content?path=${encodeURIComponent(file.relative)}` };
  }

  async content(relativePath) {
    const file = await this.resolveExisting(relativePath, "file");
    const type = previewType(file.absolute, file.stat.size);
    if (!type || !["image", "pdf"].includes(type.kind)) throw workspaceError(415, "此接口只提供允许的图片和 PDF 预览");
    return { ...file, ...type };
  }
}

export function previewType(filePath, size) {
  const extension = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension) && size <= MAX_TEXT_PREVIEW_BYTES) {
    return { kind: extension === ".md" || extension === ".markdown" ? "markdown" : extension === ".txt" || extension === ".log" ? "text" : "code", mime: "text/plain; charset=utf-8" };
  }
  if (IMAGE_MIME.has(extension) && size <= MAX_BINARY_PREVIEW_BYTES) return { kind: "image", mime: IMAGE_MIME.get(extension) };
  if (extension === ".pdf" && size <= MAX_BINARY_PREVIEW_BYTES) return { kind: "pdf", mime: "application/pdf" };
  return null;
}

export function validateUploadFiles(files) {
  if (!Array.isArray(files) || !files.length) throw workspaceError(400, "请选择要上传的文件");
  if (files.length > MAX_UPLOAD_FILES) throw workspaceError(413, `一次最多上传${MAX_UPLOAD_FILES}个文件`);
  const seen = new Set();
  let total = 0;
  const normalized = files.map((file) => {
    const name = String(file?.name || "").trim();
    const size = Number(file?.size);
    if (!name || name.length > 240 || name === "." || name === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) throw workspaceError(400, `文件名无效：${name || "空文件名"}`);
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw workspaceError(400, `Windows保留文件名不可用：${name}`);
    if (!Number.isSafeInteger(size) || size < 0) throw workspaceError(400, `文件大小无效：${name}`);
    if (size > MAX_UPLOAD_FILE_BYTES) throw workspaceError(413, `单个文件不能超过${MAX_UPLOAD_FILE_BYTES / 1024 / 1024}MB：${name}`);
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) throw workspaceError(400, `选择的文件名称重复：${name}`);
    seen.add(key);
    total += size;
    return { name, size };
  });
  if (total > MAX_UPLOAD_TOTAL_BYTES) throw workspaceError(413, `一次上传总大小不能超过${MAX_UPLOAD_TOTAL_BYTES / 1024 / 1024}MB`);
  return normalized;
}

export function resolveLexically(root, relativePath = "") {
  if (typeof relativePath !== "string" || relativePath.includes("\0")) throw workspaceError(400, "工作区路径无效");
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) throw workspaceError(403, "仅允许工作区相对路径");
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw workspaceError(403, "禁止路径穿越");
  const candidate = path.resolve(root, ...segments);
  assertInside(candidate, path.resolve(root));
  return candidate;
}

function assertInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw workspaceError(403, "禁止访问工作区之外的路径");
}

function toRelative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function workspaceError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
