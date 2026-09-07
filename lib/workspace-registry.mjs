import crypto from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const VERSION = 1;
const NAME_MAX = 60;

export class WorkspaceRegistry {
  constructor({ filePath, backupDir, defaultRoot, log = console, platform = process.platform, homeDir = os.homedir() }) {
    this.filePath = path.resolve(filePath);
    this.backupDir = path.resolve(backupDir);
    this.defaultRoot = path.resolve(defaultRoot);
    this.log = log;
    this.platform = platform;
    this.homeDir = homeDir;
    this.data = null;
    this.fallbackWarning = null;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await Promise.all([mkdir(path.dirname(this.filePath), { recursive: true }), mkdir(this.backupDir, { recursive: true }), mkdir(this.defaultRoot, { recursive: true })]);
    const canonicalDefault = await realpath(this.defaultRoot);
    let loaded = null;
    let original = null;
    try { original = await readFile(this.filePath, "utf8"); loaded = JSON.parse(original); }
    catch (error) { if (error.code !== "ENOENT") this.log.warn(`工作区配置读取失败，将恢复默认配置：${error.message}`); }
    if (!isRegistryData(loaded)) {
      if (original != null) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await writeFile(path.join(this.backupDir, `workspaces-invalid-${stamp}.json`), original, "utf8");
      }
      const now = new Date().toISOString();
      const item = { id: crypto.randomUUID(), name: "默认工作区", root: canonicalDefault, canonicalRoot: canonicalDefault, isDefault: true, lastSessionId: null, createdAt: now, updatedAt: now, lastUsedAt: now };
      loaded = { version: VERSION, activeWorkspaceId: item.id, items: [item] };
      this.data = loaded;
      await this.persist(false);
      return this;
    }
    this.data = loaded;
    let defaultItem = this.data.items.find((item) => item.isDefault);
    if (!defaultItem) {
      const now = new Date().toISOString();
      defaultItem = { id: crypto.randomUUID(), name: "默认工作区", root: canonicalDefault, canonicalRoot: canonicalDefault, isDefault: true, lastSessionId: null, createdAt: now, updatedAt: now, lastUsedAt: now };
      this.data.items.unshift(defaultItem);
    }
    const configuredActive = this.data.items.find((item) => item.id === this.data.activeWorkspaceId);
    if (!configuredActive || !await directoryAvailable(configuredActive.canonicalRoot)) {
      if (this.data.activeWorkspaceId !== defaultItem.id) this.fallbackWarning = "上次使用的工作区不可用，已切换到默认工作区";
      this.data.activeWorkspaceId = defaultItem.id;
    }
    await this.persist(false);
    return this;
  }

  active() { return this.get(this.data.activeWorkspaceId); }

  get(id) {
    const item = this.data?.items.find((entry) => entry.id === id);
    if (!item) throw registryError(404, "工作区不存在");
    return { ...item };
  }

  async list() {
    const items = await Promise.all(this.data.items.map(async (item) => ({ ...item, available: await directoryAvailable(item.canonicalRoot) })));
    items.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || String(b.lastUsedAt || "").localeCompare(String(a.lastUsedAt || "")) || a.name.localeCompare(b.name, "zh-CN"));
    return { activeWorkspaceId: this.data.activeWorkspaceId, items };
  }

  async add({ name, path: candidate }) {
    return this.mutate(async () => {
      const canonicalRoot = await this.validateRoot(candidate);
      if (this.data.items.some((item) => samePath(item.canonicalRoot, canonicalRoot, this.platform))) throw registryError(409, "该目录已经添加为工作区");
      if (this.data.items.some((item) => pathsOverlap(item.canonicalRoot, canonicalRoot, this.platform))) throw registryError(409, "工作区目录不能互相包含，请选择独立目录");
      const cleanName = validateName(name || path.basename(canonicalRoot));
      if (this.data.items.some((item) => item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) throw registryError(409, "工作区名称已存在");
      const now = new Date().toISOString();
      const item = { id: crypto.randomUUID(), name: cleanName, root: canonicalRoot, canonicalRoot, isDefault: false, lastSessionId: null, createdAt: now, updatedAt: now, lastUsedAt: now };
      this.data.items.push(item);
      return { ...item, available: true };
    });
  }

  async rename(id, name) {
    return this.mutate(async () => {
      const cleanName = validateName(name);
      const item = this.data.items.find((entry) => entry.id === id);
      if (!item) throw registryError(404, "工作区不存在");
      if (this.data.items.some((entry) => entry.id !== id && entry.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) throw registryError(409, "工作区名称已存在");
      item.name = cleanName;
      item.updatedAt = new Date().toISOString();
      return { ...item };
    });
  }

  async remove(id) {
    return this.mutate(async () => {
      const item = this.data.items.find((entry) => entry.id === id);
      if (!item) throw registryError(404, "工作区不存在");
      if (item.isDefault) throw registryError(409, "默认工作区不能移除");
      if (id === this.data.activeWorkspaceId) throw registryError(409, "请先切换到其他工作区");
      this.data.items = this.data.items.filter((entry) => entry.id !== id);
      return { removed: true, id };
    });
  }

  async validateRegistered(id) {
    const item = this.get(id);
    const canonical = await this.validateRoot(item.canonicalRoot);
    if (!samePath(canonical, item.canonicalRoot, this.platform)) throw registryError(409, "工作区真实路径已变化，请移除后重新添加");
    return item;
  }

  async setActive(id, lastSessionId = undefined) {
    return this.mutate(async () => {
      const item = this.data.items.find((entry) => entry.id === id);
      if (!item) throw registryError(404, "工作区不存在");
      const now = new Date().toISOString();
      this.data.activeWorkspaceId = id;
      item.lastUsedAt = now;
      item.updatedAt = now;
      if (lastSessionId !== undefined) item.lastSessionId = lastSessionId || null;
      return { ...item };
    });
  }

  async rememberSession(id, sessionId) {
    if (!sessionId) return null;
    const current = this.data.items.find((entry) => entry.id === id);
    if (current?.lastSessionId === String(sessionId)) return { ...current };
    return this.mutate(async () => {
      const item = this.data.items.find((entry) => entry.id === id);
      if (!item) return null;
      item.lastSessionId = String(sessionId);
      item.updatedAt = new Date().toISOString();
      return { ...item };
    });
  }

  async validateRoot(candidate) {
    const input = String(candidate || "").trim();
    if (!input) throw registryError(400, "请选择工作区目录");
    if (this.platform === "win32" && /^\\\\/.test(input)) throw registryError(400, "暂不支持网络路径");
    if (!path.isAbsolute(input)) throw registryError(400, "工作区必须使用绝对路径");
    let canonical;
    try { canonical = await realpath(path.resolve(input)); }
    catch { throw registryError(400, "工作区目录不存在或无法访问"); }
    const info = await stat(canonical).catch(() => null);
    if (!info?.isDirectory()) throw registryError(400, "工作区路径不是目录");
    return canonical;
  }

  async browse(candidate = "") {
    const input = String(candidate || "").trim();
    if (this.platform === "win32" && !input) {
      const drives = (await Promise.all("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(async (letter) => {
        const root = `${letter}:\\`;
        return await directoryAvailable(root) ? { name: `${letter}:`, path: root } : null;
      }))).filter(Boolean);
      return { path: "", parentPath: null, drives, directories: [] };
    }
    const start = input || this.active().canonicalRoot || this.homeDir;
    const resolved = await this.validateRoot(start);
    const entries = await readdir(resolved, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) })).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    const parsed = path.parse(resolved);
    const parentPath = samePath(parsed.root, resolved, this.platform) ? (this.platform === "win32" ? "" : null) : path.dirname(resolved);
    return { path: resolved, parentPath, drives: null, directories };
  }

  mutate(operation) {
    const queued = this.queue.then(async () => {
      const previous = structuredClone(this.data);
      try {
        const result = await operation();
        await this.persist(true);
        return result;
      } catch (error) {
        this.data = previous;
        throw error;
      }
    });
    this.queue = queued.catch(() => {});
    return queued;
  }

  async persist(withBackup) {
    if (withBackup) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await copyFile(this.filePath, path.join(this.backupDir, `workspaces-${stamp}.json`)).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
      await rename(temp, this.filePath);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw registryError(500, `保存工作区配置失败：${error.message}`);
    }
  }
}

export function validateName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > NAME_MAX) throw registryError(400, `工作区名称应为1至${NAME_MAX}个字符`);
  return name;
}

export function samePath(left, right, platform = process.platform) {
  const [a, b] = [left, right].map((value) => normalizedPath(value, platform));
  return a === b;
}

export function pathsOverlap(left, right, platform = process.platform) {
  const [a, b] = [left, right].map((value) => normalizedPath(value, platform));
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function normalizedPath(value, platform) {
  const normalized = path.resolve(String(value || "")).replace(/\\/g, "/").replace(/\/$/, "");
  return platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function isRegistryData(value) {
  return value?.version === VERSION && typeof value.activeWorkspaceId === "string" && Array.isArray(value.items) && value.items.every((item) => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.root === "string" && typeof item.canonicalRoot === "string" && typeof item.isDefault === "boolean" && typeof item.createdAt === "string" && typeof item.updatedAt === "string" && typeof item.lastUsedAt === "string");
}

async function directoryAvailable(candidate) {
  try { return (await stat(candidate)).isDirectory(); } catch { return false; }
}

function registryError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
