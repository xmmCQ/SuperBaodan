import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PiRpcRuntime } from "../lib/pi-rpc.mjs";
import { ControlledPiChild } from "./helpers/controlled-pi-child.mjs";
import { createTempProject } from "./helpers/temp-project.mjs";

async function createHarness(options = {}) {
  const temp = await createTempProject("super-baodan-rpc-");
  const root = temp.root;
  const children = [];
  const sessionFile = path.join(root, "sessions", "test.jsonl");
  const spawnProcess = (_executable, args, spawnOptions) => {
    const child = new ControlledPiChild(sessionFile, options.childOptions);
    child.args = args;
    child.spawnOptions = spawnOptions;
    children.push(child);
    return child;
  };
  const runtime = new PiRpcRuntime({
    cwd: path.join(root, "workspace"),
    sessionDir: path.join(root, "sessions"),
    agentDir: path.join(root, "agent"),
    idleTimeoutMs: options.idleTimeoutMs ?? 35,
    stopTimeoutMs: options.stopTimeoutMs ?? 20,
    startupProbeMs: 0,
    spawnProcess,
    gracefulEofMs: options.gracefulEofMs ?? 0,
    platform: options.platform,
    terminateTree: options.terminateTree,
    log: { error() {}, warn() {} },
  });
  runtime.findCliFile = () => process.execPath;
  return {
    root,
    runtime,
    children,
    cleanup: async () => {
      await runtime.stop("shutdown");
      await temp.cleanup();
    },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Pi工具进程强制使用UTF-8输出环境", async () => {
  const harness = await createHarness();
  try {
    await harness.runtime.start();
    const env = harness.children[0].spawnOptions.env;
    assert.equal(env.PYTHONUTF8, "1");
    assert.equal(env.PYTHONIOENCODING, "utf-8");
    assert.equal(env.LANG, "C.UTF-8");
    assert.equal(env.LC_ALL, "C.UTF-8");
  } finally { await harness.cleanup(); }
});

test("deleting an inactive session removes only the validated JSONL file", async () => {
  const harness = await createHarness();
  try {
    const file = path.join(harness.root, "sessions", "delete-me.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"type":"session","id":"delete-me"}\n');
    const result = await harness.runtime.deleteSession(file);
    assert.deepEqual(result, { deleted: true, activeDeleted: false, state: null });
    await assert.rejects(access(file), (error) => error.code === "ENOENT");
    await assert.rejects(harness.runtime.deleteSession(path.join(harness.root, "outside.jsonl")), /会话路径不合法/);
  } finally {
    await harness.cleanup();
  }
});

test("idle timeout closes only Pi and reports idle state", async () => {
  const harness = await createHarness();
  try {
    const events = [];
    harness.runtime.on("event", (event) => events.push(event.type));
    await harness.runtime.start();
    assert.equal(harness.runtime.state, "running");
    await wait(70);
    assert.equal(harness.runtime.state, "idle");
    assert.deepEqual(harness.children[0].signals, ["SIGTERM"]);
    assert.ok(events.includes("runtime_idle"));
    assert.ok(!events.includes("runtime_exit"));
  } finally { await harness.cleanup(); }
});

test("meaningful command resets idle timeout", async () => {
  const harness = await createHarness({ idleTimeoutMs: 50 });
  try {
    await harness.runtime.start();
    await wait(30);
    await harness.runtime.send({ type: "prompt", message: "hello" });
    await wait(30);
    assert.equal(harness.runtime.state, "running");
    await wait(35);
    assert.equal(harness.runtime.state, "idle");
  } finally { await harness.cleanup(); }
});

test("active agent is never interrupted and receives a full idle window after settling", async () => {
  const harness = await createHarness({ idleTimeoutMs: 35 });
  try {
    await harness.runtime.start();
    harness.children[0].pushEvent({ type: "agent_start" });
    await wait(70);
    assert.equal(harness.runtime.state, "busy");
    assert.deepEqual(harness.children[0].signals, []);
    harness.children[0].pushEvent({ type: "agent_settled" });
    await wait(20);
    assert.equal(harness.runtime.state, "running");
    await wait(30);
    assert.equal(harness.runtime.state, "idle");
  } finally { await harness.cleanup(); }
});

test("command after idle restarts Pi with the previous session", async () => {
  const harness = await createHarness({ idleTimeoutMs: 30 });
  try {
    await harness.runtime.start();
    const sessionPath = harness.runtime.activeSessionPath;
    await wait(65);
    assert.equal(harness.runtime.state, "idle");
    await harness.runtime.send({ type: "get_state" });
    assert.equal(harness.children.length, 2);
    const sessionIndex = harness.children[1].args.indexOf("--session");
    assert.equal(harness.children[1].args[sessionIndex + 1], sessionPath);
    assert.equal(harness.runtime.state, "running");
  } finally { await harness.cleanup(); }
});

test("stop force-kills Pi when graceful shutdown exceeds five-second policy override", async () => {
  const harness = await createHarness({ idleTimeoutMs: 5_000, stopTimeoutMs: 15, childOptions: { ignoreTerm: true } });
  try {
    await harness.runtime.start();
    await harness.runtime.stop("shutdown");
    assert.deepEqual(harness.children[0].signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(harness.runtime.state, "stopped");
  } finally { await harness.cleanup(); }
});
