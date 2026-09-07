import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PiAdmin, backupAndAtomicJson } from "../lib/pi-admin.mjs";
import { createTempProject } from "./helpers/temp-project.mjs";

test("maintenance rejects credential changes while Pi is busy", async () => {
  const runtime = { state: "busy", busyReasons: new Set(["agent"]), pending: new Map(), running: true };
  const admin = new PiAdmin({ agentDir: "C:\\agent", cwd: "C:\\work", piRuntime: runtime, log: { error() {} } });
  await assert.rejects(admin.withMaintenance(async () => {}), (error) => error.statusCode === 409);
});

test("maintenance stops and restores the same active session", async () => {
  const calls = [];
  const runtime = {
    state: "running", busyReasons: new Set(), pending: new Map(), running: true, closed: false,
    activeSessionPath: "C:\\sessions\\same.jsonl",
    async stop(reason) { calls.push(["stop", reason]); this.running = false; },
    async ensureStarted(session) { calls.push(["start", session]); this.running = true; },
  };
  const admin = new PiAdmin({ agentDir: "C:\\agent", cwd: "C:\\work", piRuntime: runtime, log: { error() {} } });
  const result = await admin.withMaintenance(async () => "ok");
  assert.equal(result, "ok");
  assert.deepEqual(calls, [["stop", "maintenance"], ["start", "C:\\sessions\\same.jsonl"]]);
});

test("maintenance reports a restart failure after applying configuration", async () => {
  const runtime = {
    state: "running", busyReasons: new Set(), pending: new Map(), running: true, closed: false,
    activeSessionPath: "C:\\sessions\\same.jsonl",
    async stop() { this.running = false; },
    async ensureStarted() { throw new Error("restart unavailable"); },
  };
  const admin = new PiAdmin({ agentDir: "C:\\agent", cwd: "C:\\work", piRuntime: runtime, log: { error() {} } });
  await assert.rejects(admin.withMaintenance(async () => "saved"), /配置已更新.*恢复失败/);
});

test("backupAndAtomicJson preserves a backup and writes valid JSON", async () => {
  const temp = await createTempProject("super-baodan-admin-test-");
  const dir = temp.root;
  const file = path.join(dir, "auth.json");
  try {
    await writeFile(file, '{"existing":true}\n');
    await backupAndAtomicJson(file, { next: true }, "auth");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { next: true });
    assert.equal((await readdir(dir)).filter((name) => name.startsWith("auth-backup-")).length, 1);
  } finally { await temp.cleanup(); }
});
