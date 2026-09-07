import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_VSKILLS, VSkillManager } from "../lib/vskill-manager.mjs";
import { createTempProject } from "./helpers/temp-project.mjs";

async function createHarness() {
  const temp = await createTempProject("super-baodan-vskills-");
  const root = temp.root;
  const filePath = path.join(root, "data", "vskills.json");
  const backupDir = path.join(root, "backups");
  let sequence = 0;
  let tick = 0;
  const options = {
    filePath,
    backupDir,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    randomUUID: () => `id-${String(++sequence).padStart(8, "0")}`,
  };
  return { root, filePath, backupDir, options, manager: new VSkillManager(options), cleanup: temp.cleanup };
}

test("首次初始化创建两个默认VSkill", async () => {
  const harness = await createHarness();
  try {
    const items = await harness.manager.list();
    assert.deepEqual(items.map(({ id, name, prompt }) => ({ id, name, prompt })), DEFAULT_VSKILLS);
    const stored = JSON.parse(await readFile(harness.filePath, "utf8"));
    assert.equal(stored.version, 1);
    assert.equal(stored.items.length, 2);
  } finally { await harness.cleanup(); }
});

test("默认VSkill允许修改删除且重启后不恢复", async () => {
  const harness = await createHarness();
  try {
    await harness.manager.initialize();
    await harness.manager.update("weekly-summary", { name: "周总结", prompt: "生成本周工作总结" });
    await harness.manager.delete("next-week-work");
    const reloaded = new VSkillManager(harness.options);
    const items = await reloaded.list();
    assert.deepEqual(items.map((item) => item.name), ["周总结"]);
    assert.equal(items[0].prompt, "生成本周工作总结");
  } finally { await harness.cleanup(); }
});

test("VSkill增删改保持顺序并在变更前备份", async () => {
  const harness = await createHarness();
  try {
    await harness.manager.initialize();
    const created = await harness.manager.create({ name: "  客户拜访  ", prompt: "\n整理客户拜访材料\n" });
    assert.equal(created.name, "客户拜访");
    assert.equal(created.prompt, "整理客户拜访材料");
    const items = await harness.manager.list();
    assert.deepEqual(items.map((item) => item.name), ["本周总结", "下周工作", "客户拜访"]);
    assert.ok((await readdir(harness.backupDir)).some((name) => name.startsWith("vskills-")));
  } finally { await harness.cleanup(); }
});

test("VSkill拒绝空值超长重复名称和非法ID", async () => {
  const harness = await createHarness();
  try {
    await harness.manager.initialize();
    await assert.rejects(harness.manager.create({ name: "", prompt: "内容" }), /名称不能为空/);
    await assert.rejects(harness.manager.create({ name: "x".repeat(31), prompt: "内容" }), /不能超过30/);
    await assert.rejects(harness.manager.create({ name: "新技能", prompt: "" }), /Prompt不能为空/);
    await assert.rejects(harness.manager.create({ name: "新技能", prompt: "x".repeat(10_001) }), /不能超过10000/);
    await assert.rejects(harness.manager.create({ name: "本周总结", prompt: "重复" }), /名称已存在/);
    await assert.rejects(harness.manager.update("../bad", { name: "坏", prompt: "坏" }), /ID无效/);
    await assert.rejects(harness.manager.delete("missing"), /VSkill不存在/);
  } finally { await harness.cleanup(); }
});
