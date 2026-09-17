import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BackendManager } from "../desktop/backend-manager.mjs";

const config = {
  root: "C:\\SuperBaodan Desktop", dataRoot: "C:\\Temp\\sb-test", piAgentDir: "C:\\Temp\\sb-test\\pi-agent",
  nodePath: "C:\\node.exe", port: 3213, baseUrl: "http://127.0.0.1:3213",
};
const silentWriter = () => ({ push() {}, close: async () => {} });

class FakeChild extends EventEmitter {
  constructor({ autoExit = true, killResult = true } = {}) {
    super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter();
    this.autoExit = autoExit; this.killResult = killResult; this.messages = []; this.kills = [];
  }
  send(message) { this.messages.push(message); if (message.type === "shutdown" && this.autoExit) queueMicrotask(() => this.exit(0, null)); }
  kill(signal) { this.kills.push(signal); if (this.killResult && this.autoExit) queueMicrotask(() => this.exit(null, signal)); return this.killResult; }
  exit(code, signal) { this.emit("exit", code, signal); }
}

function harness(options = {}) {
  const children = [], spawns = [];
  const manager = new BackendManager(config, {
    prepare: options.prepare || (async () => {}),
    portAvailable: options.portAvailable || (async () => true),
    spawnProcess: (...args) => {
      const child = options.childFactory?.() || new FakeChild(options.childOptions);
      child.runId = args[2].env.SUPER_BAODAN_DESKTOP_RUN_ID;
      children.push(child); spawns.push(args); return child;
    },
    createLogWriter: silentWriter,
    startupTimeoutMs: 1_000, stopTimeoutMs: options.stopTimeoutMs || 100, killTimeoutMs: 30,
  });
  return { manager, children, spawns };
}

async function waitForChild(children, index = 0) {
  for (let i = 0; i < 50 && !children[index]; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(children[index], "expected child process");
  return children[index];
}

async function ready(manager, children, index = 0) {
  const child = await waitForChild(children, index);
  child.emit("message", { type: "ready", runId: child.runId });
  for (let i = 0; i < 20 && manager.state !== "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  return child;
}

test("同时多次 start 只创建一个进程并返回同一个 Promise", async () => {
  const { manager, children, spawns } = harness();
  const first = manager.start(), second = manager.start();
  assert.strictEqual(first, second);
  await ready(manager, children); await first;
  assert.equal(spawns.length, 1); assert.equal(manager.state, "running");
  await manager.stop();
});

test("初始化过程中 stop 会取消启动且不会创建进程", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { manager, spawns } = harness({ prepare: () => gate });
  const starting = manager.start();
  const stopping = manager.stop();
  release();
  await assert.rejects(starting, { code: "START_CANCELLED" });
  assert.equal(await stopping, true);
  assert.equal(spawns.length, 0); assert.equal(manager.state, "idle");
});

test("等待 ready 时 stop 只关闭本轮创建的进程", async () => {
  const { manager, children } = harness();
  const starting = manager.start();
  const child = await waitForChild(children);
  const stopping = manager.stop();
  await assert.rejects(starting, { code: "START_CANCELLED" });
  assert.equal(await stopping, true);
  assert.deepEqual(child.messages.map((item) => item.type), ["shutdown"]);
  assert.equal(manager.state, "idle");
});

test("多次 stop 共用同一个停止过程", async () => {
  const { manager, children } = harness();
  const starting = manager.start(); await ready(manager, children); await starting;
  const first = manager.stop(), second = manager.stop();
  assert.strictEqual(first, second);
  assert.equal(await first, true);
});

test("未知服务占用端口时不创建进程也不发送关闭请求", async () => {
  const { manager, spawns } = harness({ portAvailable: async () => false });
  await assert.rejects(manager.start(), { code: "PORT_IN_USE" });
  assert.equal(spawns.length, 0); assert.equal(manager.state, "failed");
});

test("正常退出与异常退出记录状态", async () => {
  const normal = harness(); const normalStart = normal.manager.start(); await ready(normal.manager, normal.children); await normalStart;
  assert.equal(await normal.manager.stop(), true); assert.equal(normal.manager.state, "idle");
  const abnormal = harness(); const abnormalStart = abnormal.manager.start(); const child = await ready(abnormal.manager, abnormal.children); await abnormalStart;
  child.exit(7, null); await childListeners();
  assert.equal(abnormal.manager.state, "failed");
});

test("旧进程迟到事件不影响新实例", async () => {
  const { manager, children } = harness();
  const firstStart = manager.start(); const first = await ready(manager, children, 0); await firstStart;
  first.exit(9, null); await childListeners();
  const secondStart = manager.start(); await ready(manager, children, 1); await secondStart;
  await manager.handleExit(manager.createRun(), 1, null);
  assert.equal(manager.state, "running");
  await manager.stop();
});

test("强制停止失败不会报告成功", async () => {
  const { manager, children } = harness({ childOptions: { autoExit: false, killResult: false }, stopTimeoutMs: 10 });
  const starting = manager.start(); await ready(manager, children); await starting;
  assert.equal(await manager.stop(10), false);
  assert.equal(await manager.forceStop(), false);
  assert.equal(manager.state, "stopping");
  children[0].exit(1, null); await childListeners();
});

function childListeners() { return new Promise((resolve) => setTimeout(resolve, 5)); }
