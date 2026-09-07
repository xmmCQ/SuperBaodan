import crypto from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const STORE_VERSION = 1;
const MAX_TITLE_LENGTH = 100;
const MAX_CONTENT_LENGTH = 50_000;
const MAX_QUERY_LENGTH = 100;
const MAX_SEARCH_RESULTS = 50;
const TYPES = new Set(["meeting", "work", "idea", "other"]);
const TYPE_LABELS = { meeting: "会议纪要", work: "工作记录", idea: "想法随记", other: "其他" };

export class DailyRecordManager {
  constructor({ filePath, backupDir, now = () => new Date(), randomUUID = () => crypto.randomUUID() }) {
    this.filePath = filePath;
    this.backupDir = backupDir;
    this.now = now;
    this.randomUUID = randomUUID;
    this.initializing = null;
    this.mutationTail = Promise.resolve();
  }

  async initialize() {
    if (!this.initializing) this.initializing = this.initializeStore();
    return this.initializing;
  }

  async initializeStore() {
    await Promise.all([mkdir(path.dirname(this.filePath), { recursive: true }), mkdir(this.backupDir, { recursive: true })]);
    if (!existsSync(this.filePath)) await this.atomicWrite({ version: STORE_VERSION, items: [] });
    await this.readStore();
    return this;
  }

  async listByDate(date) {
    validateDate(date);
    const store = await this.readInitializedStore();
    return store.items.filter((item) => item.date === date).sort(compareDailyRecords).map(clone);
  }

  async monthSummary(month) {
    validateMonth(month);
    const store = await this.readInitializedStore();
    const counts = new Map();
    for (const item of store.items) {
      if (item.date.startsWith(`${month}-`)) counts.set(item.date, (counts.get(item.date) || 0) + 1);
    }
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, count]) => ({ date, count }));
  }

  async search(rawQuery) {
    const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
    if (!query) throw recordError(400, "请输入搜索关键词");
    if (query.length > MAX_QUERY_LENGTH) throw recordError(400, `搜索关键词不能超过${MAX_QUERY_LENGTH}个字符`);
    const key = query.toLocaleLowerCase("zh-CN");
    const store = await this.readInitializedStore();
    const matched = store.items.filter((item) => [item.title, item.content, item.date, TYPE_LABELS[item.type]]
      .some((value) => String(value).toLocaleLowerCase("zh-CN").includes(key)))
      .sort(compareSearchResults);
    return { records: matched.slice(0, MAX_SEARCH_RESULTS).map(clone), total: matched.length, truncated: matched.length > MAX_SEARCH_RESULTS };
  }

  async create(input) {
    return this.mutate(async (store) => {
      const values = validateCreateInput(input);
      const timestamp = this.now().toISOString();
      const record = { id: this.randomUUID(), ...values, createdAt: timestamp, updatedAt: timestamp };
      validateRecord(record);
      store.items.push(record);
      return { result: clone(record), changed: true };
    });
  }

  async update(id, input) {
    const safeId = validateId(id);
    return this.mutate(async (store) => {
      const index = store.items.findIndex((item) => item.id === safeId);
      if (index < 0) throw recordError(404, "每日记录不存在");
      const current = store.items[index];
      assertRevision(input?.revision, current.updatedAt);
      const values = validateEditableInput(input);
      if (current.title === values.title && current.type === values.type && current.time === values.time && current.content === values.content) {
        return { result: clone(current), changed: false };
      }
      const record = { ...current, ...values, updatedAt: nextTimestamp(this.now(), current.updatedAt) };
      store.items[index] = record;
      return { result: clone(record), changed: true };
    });
  }

  async delete(id, revision) {
    const safeId = validateId(id);
    return this.mutate(async (store) => {
      const index = store.items.findIndex((item) => item.id === safeId);
      if (index < 0) throw recordError(404, "每日记录不存在");
      assertRevision(revision, store.items[index].updatedAt);
      const [removed] = store.items.splice(index, 1);
      return { result: clone(removed), changed: true };
    });
  }

  async mutate(operation) {
    await this.initialize();
    const run = async () => {
      const store = await this.readStore();
      const { result, changed } = await operation(store);
      if (changed) {
        await this.backup();
        await this.atomicWrite(store);
        await this.trimBackups();
      }
      return result;
    };
    const pending = this.mutationTail.then(run, run);
    this.mutationTail = pending.catch(() => {});
    return pending;
  }

  async readInitializedStore() {
    await this.initialize();
    return this.readStore();
  }

  async readStore() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.items)) throw new Error("文件结构无效");
      const ids = new Set();
      const items = parsed.items.map((item) => {
        const record = validateRecord(item);
        if (ids.has(record.id)) throw new Error(`每日记录ID重复：${record.id}`);
        ids.add(record.id);
        return record;
      });
      return { version: STORE_VERSION, items };
    } catch (error) {
      if (error.statusCode) throw error;
      throw recordError(500, `每日记录读取失败：${error.message}`);
    }
  }

  async backup() {
    if (!existsSync(this.filePath)) return;
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    await copyFile(this.filePath, path.join(this.backupDir, `daily-records-${stamp}-${this.randomUUID().slice(0, 8)}.json`));
  }

  async trimBackups() {
    const files = (await readdir(this.backupDir)).filter((name) => name.startsWith("daily-records-") && name.endsWith(".json")).sort().reverse();
    await Promise.all(files.slice(30).map((name) => unlink(path.join(this.backupDir, name)).catch(() => {})));
  }

  async atomicWrite(store) {
    const temp = `${this.filePath}.super-baodan-${process.pid}-${Date.now()}-${this.randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.filePath);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
}

function validateCreateInput(input) {
  return { date: validateDate(input?.date), ...validateEditableInput(input) };
}

function validateEditableInput(input) {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  const type = typeof input?.type === "string" ? input.type : "";
  const time = typeof input?.time === "string" ? input.time.trim() : "";
  const content = typeof input?.content === "string" ? input.content : "";
  if (!title) throw recordError(400, "记录标题不能为空");
  if (title.length > MAX_TITLE_LENGTH) throw recordError(400, `记录标题不能超过${MAX_TITLE_LENGTH}个字符`);
  if (!TYPES.has(type)) throw recordError(400, "记录类型无效");
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw recordError(400, "记录时间格式无效");
  if (!content.trim()) throw recordError(400, "记录正文不能为空");
  if (content.length > MAX_CONTENT_LENGTH) throw recordError(400, `记录正文不能超过${MAX_CONTENT_LENGTH}个字符`);
  return { title, type, time, content };
}

function validateRecord(item) {
  const id = validateId(item?.id);
  const date = validateDate(item?.date);
  const values = validateEditableInput(item);
  const createdAt = validateTimestamp(item?.createdAt);
  const updatedAt = validateTimestamp(item?.updatedAt);
  return { id, date, ...values, createdAt, updatedAt };
}

function validateId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw recordError(400, "每日记录ID无效");
  }
  return value;
}

function validateDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw recordError(400, "记录日期格式无效");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw recordError(400, "记录日期无效");
  return value;
}

function validateMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw recordError(400, "月份格式无效");
  return value;
}

function validateTimestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error("记录时间戳无效");
  return value;
}

function assertRevision(revision, current) {
  if (!revision) throw recordError(400, "缺少记录版本，请刷新后重试");
  if (revision !== current) throw recordError(409, "记录已在其他位置更新，请刷新后重试");
}

function nextTimestamp(now, current) {
  const proposed = now.toISOString();
  if (Date.parse(proposed) > Date.parse(current)) return proposed;
  return new Date(Date.parse(current) + 1).toISOString();
}

function compareDailyRecords(left, right) {
  if (left.time && right.time && left.time !== right.time) return left.time.localeCompare(right.time);
  if (left.time && !right.time) return -1;
  if (!left.time && right.time) return 1;
  return right.createdAt.localeCompare(left.createdAt);
}

function compareSearchResults(left, right) {
  return right.date.localeCompare(left.date) || right.updatedAt.localeCompare(left.updatedAt);
}

function clone(value) { return { ...value }; }

function recordError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
