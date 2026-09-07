import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PiRpcRuntime } from "../lib/pi-rpc.mjs";
import { ControlledPiChild } from "./helpers/controlled-pi-child.mjs";
import { createTempProject } from "./helpers/temp-project.mjs";

async function harness(options = {}) {
  const temp = await createTempProject("super-baodan-race-");
  const root = temp.root;
  const children = [];
  const sessionFile = path.join(root, "sessions", "race.jsonl");
  const runtime = new PiRpcRuntime({
    cwd: path.join(root, "workspace"),
    sessionDir: path.join(root, "sessions"),
    agentDir: path.join(root, "agent"),
    idleTimeoutMs: options.idleTimeoutMs || 40,
    stopTimeoutMs: options.stopTimeoutMs || 15,
    startupProbeMs: 0,
    gracefulEofMs: 0,
    platform: options.platform,
    terminateTree: options.terminateTree,
    spawnProcess: (_file, args) => {
      const child = new ControlledPiChild(sessionFile, { sessionId: "race-session", ...options.childOptions });
      child.args = args;
      children.push(child);
      return child;
    },
    log: { error() {}, warn() {} },
  });
  runtime.findCliFile = () => process.execPath;
  return { runtime, children, root, cleanup: async () => { await runtime.close(); await temp.cleanup(); } };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("concurrent new-session transitions never leave more than one live Pi child", async () => {
  const h = await harness({ idleTimeoutMs: 5_000 });
  try {
    await Promise.all([h.runtime.newSession(), h.runtime.newSession(), h.runtime.newSession()]);
    assert.equal(h.children.filter((child) => child.exitCode === null).length, 1);
    assert.equal(h.runtime.child, h.children.at(-1));
  } finally { await h.cleanup(); }
});

test("close is terminal and a concurrent command cannot restart Pi", async () => {
  const h = await harness({ idleTimeoutMs: 5_000 });
  try {
    await h.runtime.start();
    const closing = h.runtime.close();
    await assert.rejects(h.runtime.send({ type: "get_state" }), /运行时已关闭/);
    await closing;
    assert.equal(h.children.length, 1);
    assert.equal(h.children.filter((child) => child.exitCode === null).length, 0);
  } finally { await h.cleanup(); }
});

test("idle timeout waits for a delayed non-bash RPC response", async () => {
  const h = await harness({ idleTimeoutMs: 30 });
  try {
    await h.runtime.start();
    h.children[0].responseDelayMs = 55;
    const pending = h.runtime.send({ type: "get_available_models" });
    await wait(40);
    assert.equal(h.runtime.state, "running");
    await pending;
    await wait(20);
    assert.equal(h.runtime.state, "running");
    await wait(20);
    assert.equal(h.runtime.state, "idle");
  } finally { await h.cleanup(); }
});

test("failed startup handshake cleans up the child and reports error once", async () => {
  const h = await harness({ childOptions: { failHandshake: true }, idleTimeoutMs: 5_000 });
  try {
    const exits = [];
    h.runtime.on("event", (event) => { if (event.type === "runtime_exit") exits.push(event); });
    await assert.rejects(h.runtime.start(), /handshake failed/);
    assert.equal(h.runtime.state, "error");
    assert.equal(h.children.filter((child) => child.exitCode === null).length, 0);
    assert.equal(exits.length, 1);
  } finally { await h.cleanup(); }
});

test("unexpected child error without an exit event finalizes runtime once", async () => {
  const h = await harness({ idleTimeoutMs: 5_000 });
  try {
    const exits = [];
    h.runtime.on("event", (event) => { if (event.type === "runtime_exit") exits.push(event); });
    await h.runtime.start();
    h.children[0].emit("error", new Error("pipe failed"));
    await wait(10);
    assert.equal(h.runtime.state, "error");
    assert.equal(h.runtime.child, null);
    assert.equal(exits.length, 1);
  } finally { await h.cleanup(); }
});

test("Windows shutdown invokes process-tree termination", async () => {
  let terminatedPid = null;
  let child;
  const h = await harness({
    platform: "win32",
    idleTimeoutMs: 5_000,
    terminateTree: async (pid) => {
      terminatedPid = pid;
      child.kill("SIGKILL");
    },
  });
  try {
    await h.runtime.start();
    child = h.children[0];
    await h.runtime.stop("shutdown");
    assert.equal(terminatedPid, child.pid);
    assert.equal(child.exitCode, 137);
  } finally { await h.cleanup(); }
});
