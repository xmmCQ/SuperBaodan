import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createServerApplication } from "../server/app.mjs";
import { DailyRecordManager } from "../lib/daily-record-manager.mjs";
import { createTempProject } from "./helpers/temp-project.mjs";

test("每日记录API完成创建、查询、搜索、更新、冲突和删除", async (t) => {
  const project = await createTempProject("super-baodan-daily-api-");
  const manager = new DailyRecordManager({ filePath: project.resolve("daily-records.json"), backupDir: project.resolve("backups") });
  await manager.initialize();
  const context = {
    config: { host: "127.0.0.1", port: 0, publicDir: path.resolve("public") },
    dailyRecordManager: manager,
    workspaceSwitching: false,
    shuttingDown: false,
    attachServer(server) { this.server = server; },
  };
  const server = createServerApplication(context);
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  context.config.port = server.address().port;
  const base = `http://127.0.0.1:${context.config.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await project.cleanup();
  });
  const request = (url, options = {}) => fetch(`${base}${url}`, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });

  const createdResponse = await request("/api/daily-records", {
    method: "POST",
    body: JSON.stringify({ date: "2026-09-04", title: "接口例会", type: "meeting", time: "10:00", content: "确认方案" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).record;

  const listed = await (await request("/api/daily-records?date=2026-09-04")).json();
  assert.equal(listed.records[0].id, created.id);
  assert.deepEqual((await (await request("/api/daily-records/summary?month=2026-09")).json()).dates, [{ date: "2026-09-04", count: 1 }]);
  assert.equal((await (await request("/api/daily-records/search?q=方案")).json()).total, 1);

  const updatedResponse = await request(`/api/daily-records/${created.id}`, {
    method: "PUT",
    body: JSON.stringify({ revision: created.updatedAt, title: "接口例会更新", type: "meeting", time: "10:30", content: "更新方案" }),
  });
  assert.equal(updatedResponse.status, 200);
  const updated = (await updatedResponse.json()).record;

  const conflict = await request(`/api/daily-records/${created.id}`, {
    method: "PUT",
    body: JSON.stringify({ revision: created.updatedAt, title: "旧页面", type: "work", time: "", content: "不应覆盖" }),
  });
  assert.equal(conflict.status, 409);

  const deleted = await request(`/api/daily-records/${created.id}`, { method: "DELETE", body: JSON.stringify({ revision: updated.updatedAt }) });
  assert.equal(deleted.status, 200);
  assert.deepEqual((await (await request("/api/daily-records?date=2026-09-04")).json()).records, []);
  assert.equal((await request("/api/daily-records?date=2026-02-30")).status, 400);
});
