import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { sdkHarness, wait, deferred } from "./helpers/fake-sdk-host.mjs";
import { prepareSdkEnvironment } from "../lib/pi-sdk-factory.mjs";
import { createSdkUi, toBrowserAgentEvent } from "../lib/pi-sdk-ui.mjs";
import { AGENT_COMMAND_TYPES } from "../lib/agent-commands.mjs";

test("SDK工具沿用UTF-8环境且不重复添加Windows包装路径", () => {
  const env = { Path: "C:\\Windows" };
  prepareSdkEnvironment("C:\\agent", env, "win32");
  const first = env.Path;
  prepareSdkEnvironment("C:\\agent", env, "win32");
  assert.equal(env.Path, first);
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PYTHONIOENCODING, "utf-8");
  assert.equal(env.PI_CODING_AGENT_DIR, "C:\\agent");
});

test("并发启动仅创建一个SDK会话，HTTP状态读取不创建第二个Agent", async () => {
  const h = await sdkHarness({ beforeCreate: () => wait(10) });
  try {
    await Promise.all([h.runtime.ensureStarted(), h.runtime.ensureStarted(), h.runtime.send({ type: "get_state" })]);
    assert.equal(h.hosts.length, 1);
    assert.equal(h.runtime.state, "running");
    assert.equal((await h.runtime.send({ type: "get_available_models" })).models[0].id, "test");
    assert.equal(h.hosts[0].session.bindings.mode, "rpc");
  } finally { await h.cleanup(); }
});

test("prompt在预检通过后返回，不等待整轮生成；运行时不会休眠", async () => {
  const admission = deferred(), completion = deferred();
  const h = await sdkHarness({ idleTimeoutMs: 20, onAbort: () => completion.resolve(), prompt: async (session, message, config) => {
    assert.equal(message, "hello");
    await admission.promise;
    session.isStreaming = true;
    config.preflightResult(true);
    await completion.promise;
    session.isStreaming = false;
  } });
  try {
    await h.runtime.start();
    let acknowledged = false;
    const sending = h.runtime.send({ type: "prompt", message: "hello" }).then(() => { acknowledged = true; });
    await wait(10); assert.equal(acknowledged, false);
    admission.resolve(); await sending;
    assert.equal(acknowledged, true); assert.equal(h.runtime.state, "busy");
    await wait(45); assert.equal(h.runtime.running, true);
    completion.resolve(); await wait(45);
    assert.equal(h.runtime.state, "idle");
    assert.ok(h.order.indexOf("abort") < h.order.indexOf("shutdown"));
    assert.ok(h.order.includes("flush"));
  } finally { admission.resolve(); completion.resolve(); await h.cleanup(); }
});

test("预检拒绝会作为请求错误返回；受理后异常走事件并复位", async () => {
  const h = await sdkHarness({ prompt: async (_s, message, config) => {
    if (message === "reject") { config.preflightResult(false); throw new Error("no model"); }
    config.preflightResult(true); await wait(5); throw new Error("network lost");
  } });
  try {
    await assert.rejects(h.runtime.send({ type: "prompt", message: "reject" }), /no model/);
    await h.runtime.send({ type: "prompt", message: "accept" });
    await wait(15);
    assert.equal(h.runtime.promptRuns.size, 0);
    assert.equal(h.runtime.pending.size, 0);
    assert.equal(h.runtime.state, "running");
    assert.ok(h.events.some((event) => event.type === "extension_error" && event.error === "network lost"));
  } finally { await h.cleanup(); }
});

test("图片、排队行为及来源原样传给SDK", async () => {
  const images = [{ type: "image", data: "YWJj", mimeType: "image/png" }];
  let actual;
  const h = await sdkHarness({ prompt: async (_s, _m, config) => { actual = config; config.preflightResult(true); } });
  try {
    await h.runtime.send({ type: "prompt", message: "image", images, streamingBehavior: "followUp" });
    assert.deepEqual(actual.images, images);
    assert.equal(actual.streamingBehavior, "followUp"); assert.equal(actual.source, "rpc");
  } finally { await h.cleanup(); }
});

test("两次预检串行受理，避免空闲时并发启动两轮", async () => {
  const gate = deferred();
  const calls = [];
  const h = await sdkHarness({ prompt: async (_s, message, config) => {
    calls.push(message);
    if (message === "first") await gate.promise;
    config.preflightResult(true);
  } });
  try {
    await h.runtime.start();
    const first = h.runtime.send({ type: "prompt", message: "first" });
    const second = h.runtime.send({ type: "prompt", message: "second" });
    await wait(10); assert.deepEqual(calls, ["first"]);
    gate.resolve(); await Promise.all([first, second]);
    assert.deepEqual(calls, ["first", "second"]);
  } finally { gate.resolve(); await h.cleanup(); }
});

test("读取状态不推迟休眠，未落盘会话休眠后保留ID", async () => {
  const h = await sdkHarness({ idleTimeoutMs: 5000 });
  try {
    await h.runtime.start();
    const timer = h.runtime.idleTimer;
    const first = await h.runtime.send({ type: "get_state" });
    for (let i = 0; i < 3; i += 1) await h.runtime.send({ type: "get_state" });
    assert.equal(h.runtime.idleTimer, timer, "状态读取不能重设休眠计时器");
    // Explicit expiry avoids Windows timer jitter causing a late read to wake
    // the session during the test itself.
    await h.runtime.handleIdleTimeout(); assert.equal(h.runtime.state, "idle");
    const next = await h.runtime.send({ type: "get_state" });
    assert.equal(next.sessionId, first.sessionId);
    assert.equal(h.hosts.length, 2);
  } finally { await h.cleanup(); }
});

test("生成、压缩、重试及扩展对话期间不关闭SDK", async () => {
  const h = await sdkHarness({ idleTimeoutMs: 20 });
  try {
    await h.runtime.start();
    for (const [start, end] of [["agent_start", "agent_settled"], ["compaction_start", "compaction_end"], ["auto_retry_start", "auto_retry_end"]]) {
      h.hosts[0].push({ type: start }); await wait(30);
      assert.equal(h.runtime.running, true); h.hosts[0].push({ type: end });
    }
    const question = h.hosts[0].session.bindings.uiContext.confirm("继续？", "confirm");
    await wait(30); assert.equal(h.runtime.running, true);
    const request = h.runtime.pendingUiRequests()[0];
    await h.runtime.send({ type: "extension_ui_response", id: request.id, confirmed: true });
    assert.equal(await question, true);
    await wait(35); assert.equal(h.runtime.state, "idle");
  } finally { await h.cleanup(); }
});

test("session_start等待弹窗时仍能接收回复", async () => {
  const h = await sdkHarness({ bind: async (_s, bindings) => { assert.equal(await bindings.uiContext.input("初始化"), "ok"); } });
  try {
    const start = h.runtime.ensureStarted();
    while (!h.runtime.pendingUiRequests().length) await wait(1);
    const request = h.runtime.pendingUiRequests()[0];
    await h.runtime.send({ type: "extension_ui_response", id: request.id, value: "ok" });
    await start; assert.equal(h.runtime.state, "running");
  } finally { await h.cleanup(); }
});

test("停止会取消扩展对话、abort并触发shutdown/dispose，不退出宿主", async () => {
  const completion = deferred();
  const h = await sdkHarness({ onAbort: () => completion.resolve(), prompt: async (s, _m, config) => {
    s.isStreaming = true; config.preflightResult(true); await completion.promise; s.isStreaming = false;
  } });
  try {
    await h.runtime.send({ type: "prompt", message: "run" });
    await assert.rejects(h.runtime.newSession(), /正在运行/);
    const question = h.hosts[0].session.bindings.uiContext.confirm("确认", "继续");
    await h.runtime.stop(); assert.equal(await question, false);
    assert.equal(h.runtime.running, false); assert.equal(h.runtime.pendingUiRequests().length, 0);
    assert.ok(h.order.includes("shutdown")); assert.ok(h.order.includes("dispose"));
  } finally { completion.resolve(); await h.cleanup(); }
});

test("清理超时不偷偷创建第二个Agent，等待释放后可恢复", async () => {
  const gate = deferred();
  const h = await sdkHarness({ disposeGate: gate, stopTimeoutMs: 15 });
  try {
    await h.runtime.start();
    await assert.rejects(h.runtime.stop(), /清理超时/);
    assert.equal(h.runtime.state, "error");
    await assert.rejects(h.runtime.ensureStarted(), /切换或关闭/);
    assert.equal(h.hosts.length, 1);
    gate.resolve(); await wait(5);
    await h.runtime.ensureStarted(); assert.equal(h.hosts.length, 2);
  } finally { gate.resolve(); await h.cleanup(); }
});

test("启动失败被报告，关闭期间的晚到创建会被清理", async () => {
  let failing = true;
  const h = await sdkHarness({ beforeCreate: async () => { await wait(5); if (failing) throw new Error("SDK failed"); } });
  try {
    await assert.rejects(h.runtime.ensureStarted(), /SDK failed/);
    assert.equal(h.runtime.state, "error"); assert.equal(h.runtime.running, false);
    failing = false;
    const start = h.runtime.ensureStarted();
    await wait(1);
    const closing = h.runtime.close();
    await assert.rejects(start, /已关闭/); await closing;
    assert.equal(h.runtime.running, false);
    await assert.rejects(h.runtime.send({ type: "get_state" }), /已关闭/);
  } finally { await h.cleanup(); }
});

test("会话列表/非活动会话改名不创建SDK；删除只操作登记目录", async () => {
  const h = await sdkHarness();
  try {
    const file = await h.temp.write("sessions/saved.jsonl", `${JSON.stringify({ type: "session", id: "saved", cwd: h.runtime.cwd })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "历史记录" } })}\n`);
    const list = await h.runtime.listSessions(); assert.equal(list[0].title, "历史记录");
    await h.runtime.renameSession(file, "new title");
    assert.equal(h.hosts.length, 0); assert.ok(h.order.some((item) => item[0] === "rename"));
    await h.runtime.deleteSession(file); await assert.rejects(access(file));
    await assert.rejects(h.runtime.deleteSession(h.temp.resolve("outside.jsonl")), /路径不合法/);
  } finally { await h.cleanup(); }
});

test("全部已有命令都有SDK实现，禁止未知命令", async () => {
  const h = await sdkHarness();
  try {
    await h.runtime.start();
    const implemented = new Set(["prompt", "abort", "clear_queue", "steer", "follow_up", "set_model", "set_thinking_level", "compact", "set_auto_compaction", "set_auto_retry", "get_state", "get_messages", "get_available_models", "get_available_thinking_levels", "get_commands", "set_session_name", "bash", "abort_bash", "get_session_stats", "get_last_assistant_text", "extension_ui_response", "abort_retry"]);
    assert.deepEqual(implemented, AGENT_COMMAND_TYPES);
    assert.equal((await h.runtime.send({ type: "get_commands" })).commands.length, 3);
    await h.runtime.send({ type: "set_thinking_level", level: "low" });
    assert.equal((await h.runtime.send({ type: "get_state" })).thinkingLevel, "low");
    assert.equal((await h.runtime.send({ type: "bash", command: "echo 中文" })).output, "中文");
    await assert.rejects(h.runtime.send({ type: "unknown" }), /不支持/);
  } finally { await h.cleanup(); }
});

test("SDK事件转成原有紧凑增量格式，不重复传送partial全文", () => {
  const call = { type: "toolCall", id: "tool-1", name: "read" };
  const event = toBrowserAgentEvent({ type: "message_update", message: { usage: { input: 1 } }, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: { content: [call] } } });
  assert.equal(event.assistantMessageEvent.id, "tool-1");
  assert.equal(event.assistantMessageEvent.toolName, "read");
  assert.equal("partial" in event.assistantMessageEvent, false);
  assert.equal("message" in event, false);
});

test("关闭能解除session_start弹窗，不在启动队列后面死锁", async () => {
  const h = await sdkHarness({ bind: async (_s, bindings) => { await bindings.uiContext.confirm("startup", "wait"); } });
  try {
    const start = h.runtime.ensureStarted();
    while (!h.runtime.pendingUiRequests().length) await wait(1);
    const close = h.runtime.close();
    await assert.rejects(start, /已关闭/); await close;
    assert.equal(h.runtime.running, false);
  } finally { await h.cleanup(); }
});

test("SDK扩展切换失败会移除失效host，允许下次重新初始化", async () => {
  const h = await sdkHarness();
  try {
    await h.runtime.start();
    await assert.rejects(h.runtime.replaceFromExtension(h.hosts[0], async () => { throw new Error("replacement failed"); }), /replacement failed/);
    assert.equal(h.runtime.running, false); assert.equal(h.runtime.state, "error");
    await h.runtime.ensureStarted(); assert.equal(h.hosts.length, 2);
  } finally { await h.cleanup(); }
});

test("停止等待尚未返回的SDK命令，不能提前释放会话", async () => {
  const gate = deferred();
  const h = await sdkHarness({ stopTimeoutMs: 15 });
  try {
    await h.runtime.start();
    h.hosts[0].session.executeBash = () => gate.promise;
    const command = h.runtime.send({ type: "bash", command: "slow" });
    await wait(1);
    await assert.rejects(h.runtime.stop(), /清理超时/);
    assert.equal(h.hosts[0].session.disposed, undefined);
    gate.resolve({ output: "done", exitCode: 0 }); await command; await wait(5);
    assert.equal(h.runtime.running, false);
  } finally { gate.resolve(); await h.cleanup(); }
});

test("UI超时、取消、非法选项与迟到回复不会泄露pending", async () => {
  const events = [], bridge = createSdkUi({ emit: (event) => events.push(event), theme: {} });
  assert.equal(await bridge.ui.confirm("timeout", "", { timeout: 5 }), false);
  const controller = new AbortController();
  const input = bridge.ui.input("input", "", { signal: controller.signal }); controller.abort();
  assert.equal(await input, undefined);
  const select = bridge.ui.select("choose", ["A"]);
  bridge.respond({ id: events.at(-1).id, value: "B" }); assert.equal(await select, undefined);
  bridge.respond({ id: events[0].id, confirmed: true });
  assert.deepEqual(bridge.requests(), []); bridge.close();
});
