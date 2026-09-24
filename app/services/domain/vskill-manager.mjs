import { fault } from '../../shared/errors.js';
import { readFile } from "node:fs/promises";
import { initializeJsonFile, backupJsonFile, queueJsonMutation } from '../json-store-operations.mjs';
import crypto from "node:crypto";

const STORE_VERSION = 1;
const MAX_NAME_LENGTH = 30;
const MAX_PROMPT_LENGTH = 10_000;

export const DEFAULT_VSKILLS = [
  { id: "weekly-summary", name: "本周总结", prompt: "总结一周工作" },
  { id: "next-week-work", name: "下周工作", prompt: "总结下周要做的工作" },
];

export class VSkillManager {
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
    await initializeJsonFile(this,()=>{
      const timestamp = this.now().toISOString();
      return {version:STORE_VERSION,items:DEFAULT_VSKILLS.map(item=>({...item,createdAt:timestamp,updatedAt:timestamp}))};
    });
    await this.readStore();
    return this;
  }

  async list() {
    await this.initialize();
    const store = await this.readStore();
    return store.items.map((item) => ({ ...item }));
  }

  async create(input) {
    return this.mutate(async (store) => {
      const values = validateInput(input);
      assertUniqueName(store.items, values.name);
      const timestamp = this.now().toISOString();
      const item = { id: this.randomUUID(), ...values, createdAt: timestamp, updatedAt: timestamp };
      store.items.push(item);
      return { result: { ...item }, changed: true };
    });
  }

  async update(id, input) {
    const safeId = validateId(id);
    return this.mutate(async (store) => {
      const index = store.items.findIndex((item) => item.id === safeId);
      if (index < 0) throw fault(404, "VSkill不存在");
      const values = validateInput(input);
      assertUniqueName(store.items, values.name, safeId);
      const current = store.items[index];
      if (current.name === values.name && current.prompt === values.prompt) return { result: { ...current }, changed: false };
      const item = { ...current, ...values, updatedAt: this.now().toISOString() };
      store.items[index] = item;
      return { result: { ...item }, changed: true };
    });
  }

  async delete(id) {
    const safeId = validateId(id);
    return this.mutate(async (store) => {
      const index = store.items.findIndex((item) => item.id === safeId);
      if (index < 0) throw fault(404, "VSkill不存在");
      const [removed] = store.items.splice(index, 1);
      return { result: { ...removed }, changed: true };
    });
  }

  async mutate(operation) {
    const {result,changed} = await queueJsonMutation(this,operation);
    return {...result,unchanged:!changed};
  }

  async readStore() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.items)) throw new Error("文件结构无效");
      const names = new Set();
      const items = parsed.items.map((item) => {
        const id = validateId(item?.id);
        const { name, prompt } = validateInput(item);
        const key = name.toLocaleLowerCase();
        if (names.has(key)) throw new Error(`VSkill名称重复：${name}`);
        names.add(key);
        return {
          id,
          name,
          prompt,
          createdAt: validTimestamp(item.createdAt),
          updatedAt: validTimestamp(item.updatedAt),
        };
      });
      return { version: STORE_VERSION, items };
    } catch (error) {
      if (error.statusCode) throw error;
      throw fault(500, `VSkill配置读取失败：${error.message}`);
    }
  }

  backup() { return backupJsonFile(this,'vskills'); }

}

function validateInput(input) {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  if (!name) throw fault(400, "VSkill名称不能为空");
  if (name.length > MAX_NAME_LENGTH) throw fault(400, `VSkill名称不能超过${MAX_NAME_LENGTH}个字符`);
  if (!prompt) throw fault(400, "VSkill Prompt不能为空");
  if (prompt.length > MAX_PROMPT_LENGTH) throw fault(400, `VSkill Prompt不能超过${MAX_PROMPT_LENGTH}个字符`);
  return { name, prompt };
}

function validateId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw fault(400, "VSkill ID无效");
  return value;
}

function validTimestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error("VSkill时间字段无效");
  return value;
}

function assertUniqueName(items, name, exceptId = null) {
  const key = name.toLocaleLowerCase();
  if (items.some((item) => item.id !== exceptId && item.name.toLocaleLowerCase() === key)) throw fault(409, `VSkill名称已存在：${name}`);
}

