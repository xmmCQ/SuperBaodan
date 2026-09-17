import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("桌面服务拒绝 HTTP 关闭并在父 IPC 断联后退出", { timeout: 20000 }, async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sb-desktop-ipc-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const port = await freePort(); const workspace = path.join(temp, "workspace"); await mkdir(workspace); await writeFile(path.join(temp, "work-todo.md"), "# 工作待办\n");
  const runId = "ipc-test-run";
  const child = fork(path.join(ROOT, "server.mjs"), [], {
    cwd: ROOT, silent: true, execArgv: [],
    env: {
      ...process.env, SUPER_BAODAN_PORT: String(port), SUPER_BAODAN_DATA_DIR: temp,
      SUPER_BAODAN_BACKUP_DIR: path.join(temp, "backups"), SUPER_BAODAN_WORKSPACE: workspace,
      SUPER_BAODAN_TODO_FILE: path.join(temp, "work-todo.md"), SUPER_BAODAN_SESSION_DIR: path.join(temp, "sessions"),
      SUPER_BAODAN_VSKILL_FILE: path.join(temp, "vskills.json"), SUPER_BAODAN_DAILY_RECORD_FILE: path.join(temp, "daily-records.json"),
      SUPER_BAODAN_WORKSPACE_FILE: path.join(temp, "workspaces.json"), PI_CODING_AGENT_DIR: path.join(temp, "pi-agent"),
      SUPER_BAODAN_DESKTOP_RUN_ID: runId, SUPER_BAODAN_DESKTOP_INSTANCE_ID: runId, SUPER_BAODAN_DESKTOP_CONTROLLED: "1",
    },
  });
  t.after(() => { if (child.exitCode == null) child.kill(); });
  const message = await onceMessage(child, 10_000); assert.deepEqual(message, { type: "ready", runId });
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); assert.equal(health.desktopControlled, true);
  const shutdown = await fetch(`http://127.0.0.1:${port}/api/system/shutdown`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(shutdown.status, 409); assert.equal(child.exitCode, null);
  child.disconnect();
  const exit = await onceExit(child, 8_000); assert.equal(exit.code, 0);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => {
      const { port } = server.address(); server.close(() => resolve(port));
    });
  });
}

function onceMessage(child, timeout) {
  return timed(new Promise((resolve) => child.once("message", resolve)), timeout, "等待 ready 超时");
}
function onceExit(child, timeout) {
  return timed(new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))), timeout, "等待子进程退出超时");
}
function timed(promise, timeout, message) {
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]).finally(() => clearTimeout(timer));
}
