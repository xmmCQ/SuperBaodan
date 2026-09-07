import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { DailyRecordManager } from "../lib/daily-record-manager.mjs";
import { createTempProject } from "./helpers/temp-project.mjs";

async function fixture(t) {
  const project = await createTempProject("super-baodan-daily-record-");
  t.after(project.cleanup);
  let tick = 0;
  const manager = new DailyRecordManager({
    filePath: project.resolve("data", "daily-records.json"),
    backupDir: project.resolve("data", "backups"),
    now: () => new Date(Date.UTC(2026, 8, 4, 9, 0, 0, tick++)),
    randomUUID: () => crypto.randomUUID(),
  });
  await manager.initialize();
  return { project, manager };
}

const input = (overrides = {}) => ({
  date: "2026-09-04",
  title: "票据项目例会",
  type: "meeting",
  time: "09:30",
  content: "## 会议结论\n\n保持原方案",
  ...overrides,
});

test("每日记录支持同日多条、排序、汇总和中文搜索", async (t) => {
  const { manager } = await fixture(t);
  const late = await manager.create(input({ title: "下午记录", time: "15:00" }));
  const early = await manager.create(input({ title: "晨会", time: "08:30", content: "讨论贴现业务" }));
  const untimed = await manager.create(input({ title: "随手想法", type: "idea", time: "", content: "改进查询体验" }));
  await manager.create(input({ date: "2026-09-05", title: "次日工作", type: "work", time: "", content: "准备汇报" }));

  assert.deepEqual((await manager.listByDate("2026-09-04")).map((item) => item.id), [early.id, late.id, untimed.id]);
  assert.deepEqual(await manager.monthSummary("2026-09"), [
    { date: "2026-09-04", count: 3 },
    { date: "2026-09-05", count: 1 },
  ]);
  assert.equal((await manager.search("贴现")).records[0].id, early.id);
  assert.equal((await manager.search("想法随记")).records[0].id, untimed.id);
  assert.equal((await manager.search("2026-09-05")).total, 1);
});

test("编辑和删除使用记录版本防止旧页面覆盖", async (t) => {
  const { manager } = await fixture(t);
  const created = await manager.create(input());
  const updated = await manager.update(created.id, { ...input({ title: "例会纪要（更新）" }), revision: created.updatedAt });
  assert.equal(updated.title, "例会纪要（更新）");
  assert.notEqual(updated.updatedAt, created.updatedAt);
  await assert.rejects(() => manager.update(created.id, { ...input(), revision: created.updatedAt }), (error) => error.statusCode === 409);
  await assert.rejects(() => manager.delete(created.id, created.updatedAt), (error) => error.statusCode === 409);
  assert.equal((await manager.delete(created.id, updated.updatedAt)).id, created.id);
  assert.deepEqual(await manager.listByDate(created.date), []);
});

test("字段校验拒绝非法日期、时间、类型和超长内容", async (t) => {
  const { manager } = await fixture(t);
  for (const value of [
    input({ date: "2026-02-30" }),
    input({ time: "25:00" }),
    input({ type: "secret" }),
    input({ title: "" }),
    input({ content: " " }),
    input({ content: "a".repeat(50_001) }),
  ]) await assert.rejects(() => manager.create(value), (error) => error.statusCode === 400);
  await assert.rejects(() => manager.search(" "), (error) => error.statusCode === 400);
  await assert.rejects(() => manager.delete("../bad", "x"), (error) => error.statusCode === 400);
});

test("并发写入串行化、备份限制为30份且损坏数据不被覆盖", async (t) => {
  const { project, manager } = await fixture(t);
  await Promise.all(Array.from({ length: 35 }, (_, index) => manager.create(input({
    title: `记录${index}`,
    time: "",
    content: `内容${index}`,
  }))));
  assert.equal((await manager.listByDate("2026-09-04")).length, 35);
  const backups = (await readdir(project.resolve("data", "backups"))).filter((name) => name.startsWith("daily-records-"));
  assert.equal(backups.length, 30);
  assert.equal((await readdir(project.resolve("data"))).some((name) => name.endsWith(".tmp")), false);

  const file = project.resolve("data", "daily-records.json");
  await writeFile(file, "{损坏", "utf8");
  const before = await readFile(file, "utf8");
  const broken = new DailyRecordManager({ filePath: file, backupDir: project.resolve("data", "backups") });
  await assert.rejects(() => broken.initialize(), /每日记录读取失败/);
  assert.equal(await readFile(file, "utf8"), before);
});
