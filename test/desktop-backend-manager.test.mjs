import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BackendManager } from "../app/main/backend-manager.mjs";

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
  send(message) { this.messages.push(message); if(message.type==='boot')queueMicrotask(()=>this.emit('message',{v:1,type:'ready',runId:this.runId})); if (message.type === "shutdown" && this.autoExit) queueMicrotask(() => this.exit(0, null)); }
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
    createLogWriter: options.createLogWriter || silentWriter,
    startupTimeoutMs: options.startupTimeoutMs || 1_000, stopTimeoutMs: options.stopTimeoutMs || 100, killTimeoutMs: 30,
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
  child.emit("message", { v:1, type: "hello", runId: child.runId });
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

test('启动超时且两次终止失败，反复重试不创建第二个进程；确认退出后才允许重试', async () => {
  const { manager, children, spawns } = harness({ startupTimeoutMs: 10, childOptions: { autoExit: false, killResult: false } });
  await assert.rejects(manager.start(), { code: 'STOP_INCOMPLETE' });
  const old = manager.currentRun;
  assert.ok(old);
  assert.deepEqual(children[0].kills, ['SIGTERM', 'SIGKILL']);
  for (let i = 0; i < 3; i++) await assert.rejects(manager.start(), { code: 'STOP_INCOMPLETE' });
  assert.equal(spawns.length, 1);
  children[0].exit(1, null); await childListeners();
  const retry = manager.start(); await ready(manager, children, 1); await retry;
  await manager.handleExit(old, 1, null);
  assert.equal(manager.currentRun.child, children[1]);
  children[1].exit(0, null); await childListeners();
});

test('已收到退出事件但日志清理尚未完成时不创建新实例，退出处理幂等', async () => {
  let release, closes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { manager, children } = harness({ createLogWriter: () => ({ push() {}, async close() { closes++; await gate; } }) });
  const starting = manager.start(); const child = await ready(manager, children); await starting;
  const run = manager.currentRun;
  child.exit(1, null);
  const cleanup = manager.handleExit(run, 1, null);
  await assert.rejects(manager.start(), { code: 'STOP_INCOMPLETE' });
  assert.equal(children.length, 1);
  release(); await cleanup;
  await manager.handleExit(run, 1, null); assert.equal(closes, 2);
  const retry = manager.start(); await ready(manager, children, 1); await retry;
  await manager.handleExit(run, 1, null); assert.equal(manager.state, 'running');
  await manager.stop();
});

for (const failure of ['prepare', 'spawn', 'spawn-event']) test(`${failure}失败没有存活子进程：关闭日志后可重试`, async () => {
  let first = true, closed = 0;
  const h = harness({ createLogWriter: () => ({ push() {}, async close() { closed++; } }) });
  if (failure === 'prepare') h.manager.prepare = async () => { if (first) { first = false; throw new Error('prepare failed'); } };
  else {
    const spawn = h.manager.spawnProcess;
    h.manager.spawnProcess = (...args) => {
      if (!first) return spawn(...args);
      first = false;
      if (failure === 'spawn') throw new Error('spawn failed');
      const child = new FakeChild({ autoExit: false });
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    };
  }
  await assert.rejects(h.manager.start(), /failed/);
  assert.equal(closed, 2);
  assert.equal(h.manager.currentRun, null);
  const retry = h.manager.start(); await ready(h.manager, h.children); await retry;
  await h.manager.stop();
});

function childListeners() { return new Promise((resolve) => setTimeout(resolve, 5)); }
