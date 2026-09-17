import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

const scanners = new Map();
const SUMMARY_LIMIT = 240;
function pathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
export function sameSessionPath(left, right) {
  if (!left || !right) return left === right;
  return pathKey(left) === pathKey(right);
}
export function resolveSessionPath(candidate, root) {
  const absolute = path.resolve(candidate);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !absolute.endsWith(".jsonl")) {
    throw new Error("会话路径不合法");
  }
  return absolute;
}
export async function assertSessionPath(candidate, root) {
  const absolute = resolveSessionPath(candidate, root);
  if (!existsSync(absolute)) throw new Error("会话不存在");
  const [actual, actualRoot] = await Promise.all([realpath(absolute), realpath(root)]);
  resolveSessionPath(actual, actualRoot);
  return absolute;
}

// Metadata only: never retain transcripts, images or tool output in this cache.
export class SessionListScanner {
  constructor(root, { concurrency = 4, readMetadata = readSessionMetadata, log = console } = {}) {
    this.root = path.resolve(root);
    this.concurrency = Math.max(1, Math.min(4, Math.floor(concurrency) || 1));
    this.readMetadata = readMetadata;
    this.log = log;
    this.cache = new Map();
    this.revision = 0;
    this.pending = null;
  }
  invalidate(file) {
    this.revision += 1;
    if (file) this.cache.delete(pathKey(resolveSessionPath(file, this.root)));
    else this.cache.clear();
  }
  list() {
    if (!this.pending) {
      this.pending = (async () => {
        let result, revision;
        // A write during a scan must not resurrect stale cached metadata or
        // make requests arriving after that write receive the old snapshot.
        do {
          revision = this.revision;
          result = await this.scan();
        } while (revision !== this.revision);
        return result;
      })().finally(() => { this.pending = null; });
    }
    // Callers may sort/edit their results without modifying cached objects.
    return this.pending.then((items) => items.map((item) => ({ ...item })));
  }
  async scan() {
    await mkdir(this.root, { recursive: true });
    const directories = [this.root], files = [];
    for (let index = 0; index < directories.length; index += 1) {
      const directory = directories[index];
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) directories.push(file);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
      }
    }
    const seen = new Set(files.map(pathKey));
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);
    let index = 0;
    const sessions = [];
    await Promise.all(Array.from({ length: Math.min(this.concurrency, files.length) }, async () => {
      while (index < files.length) {
        const file = files[index++];
        try {
          const metadata = await this.scanFile(file);
          if (metadata) sessions.push(metadata);
        } catch (error) {
          this.cache.delete(pathKey(file));
          if (error.code !== "ENOENT") this.log.warn(`跳过无法读取的会话 ${file}: ${error.message}`);
        }
      }
    }));
    return sessions.sort((a, b) => b.modified.localeCompare(a.modified));
  }
  async scanFile(file) {
    const key = pathKey(file);
    let latest = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await stat(file);
      const cached = this.cache.get(key);
      if (cached && unchanged(cached, before)) return cached.metadata;
      const revision = this.revision;
      const metadata = await this.readMetadata(file, before);
      latest = metadata;
      const after = await stat(file);
      if (!unchanged(before, after)) continue;
      if (revision === this.revision) this.cache.set(key, { size: after.size, mtimeMs: after.mtimeMs, metadata });
      return metadata;
    }
    // File is still being appended; show the last readable snapshot rather
    // than making the session disappear, but do not cache it.
    this.cache.delete(key);
    return latest;
  }
}
function unchanged(left, right) { return left.size === right.size && left.mtimeMs === right.mtimeMs; }

export function listSavedSessions(root, log = console) {
  const key = pathKey(root);
  if (!scanners.has(key)) scanners.set(key, new SessionListScanner(root, { log }));
  return scanners.get(key).list();
}
export function invalidateSavedSession(root, file) {
  scanners.get(pathKey(root))?.invalidate(file);
}

export async function readSessionMetadata(file, fileStat) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header, name = "", firstMessage = "", messageCount = 0;
  try {
    for await (let line of lines) {
      if (!line.trim()) continue;
      if (!header) {
        line = line.replace(/^\uFEFF/, "");
        const entry = JSON.parse(line);
        if (entry.type !== "session" || typeof entry.id !== "string") return null;
        header = { id: entry.id, cwd: entry.cwd, timestamp: entry.timestamp };
        continue;
      }
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      if (item.type === "session_info" && typeof item.name === "string") name = item.name.slice(0, 120);
      if (item.type !== "message") continue;
      messageCount += 1;
      if (!firstMessage && item.message?.role === "user") firstMessage = messageSummary(item.message);
    }
  } finally { lines.close(); input.destroy(); }
  if (!header) return null;
  return {
    id: header.id, path: file, cwd: header.cwd, name: name || null,
    title: name || firstMessage.slice(0, 60) || "新对话", firstMessage, messageCount,
    created: header.timestamp || fileStat.birthtime.toISOString(), modified: fileStat.mtime.toISOString(),
  };
}
function messageSummary(message) {
  if (typeof message.content === "string") return message.content.slice(0, SUMMARY_LIMIT);
  if (!Array.isArray(message.content)) return "";
  let summary = "";
  for (const part of message.content) {
    if (part?.type === "text" && typeof part.text === "string") summary += part.text.slice(0, SUMMARY_LIMIT - summary.length);
    if (summary.length >= SUMMARY_LIMIT) break;
  }
  return summary;
}
