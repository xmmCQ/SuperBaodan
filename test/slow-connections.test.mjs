import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createResponseFallback } from "../app/renderer/core/response-fallback.js";
import { createAgentClient } from "../app/renderer/core/agent-client.js";
import { invoke, ApplicationError } from "../app/renderer/core/service-client.js";
import { PromptReceipts } from "../app/services/prompt-receipts.mjs";
import { sdkHarness, deferred, wait } from "./helpers/fake-sdk-host.mjs";

async function until(predicate) {
  for (let i = 0; i < 100; i += 1) { if (predicate()) return; await wait(5); }
  assert.fail("condition did not settle");
}

test("降级读取single-flight，停止/重启不应用旧响应，稳定版本不重复下载消息", async () => {
  const gate = deferred();
  let reads = 0, full = 0, active = 0, peak = 0, applied = 0;
  const poll = createResponseFallback({ interval: 5, quietMs: 0, lastEventAt: () => 0,
    readSnapshot: async ({ messages }) => {
      reads += 1; peak = Math.max(peak, ++active);
      if (reads === 1) await gate.promise;
      if (messages) full += 1;
      active -= 1;
      return { state: { isStreaming: true }, messagesVersion: "v1", ...(messages ? { messages: [] } : {}) };
    }, applySnapshot: () => { applied += 1; },
  });
  try {
    poll.start(); await until(() => reads === 1); await wait(25); assert.equal(reads, 1);
    poll.stop(); poll.start(); await wait(15); assert.equal(reads, 1);
    gate.resolve(); await until(() => applied > 2);
    assert.equal(peak, 1); assert.equal(full, 1);
    poll.stop(); const before = applied; await wait(20); assert.equal(applied, before);
  } finally { gate.resolve(); poll.stop(); }
});

test("仍在收到事件时不轮询；任务结束后自动停止观察", async () => {
  let quiet = false, reads = 0;
  const poll = createResponseFallback({ interval: 5, lastEventAt: () => quiet ? 0 : Date.now(),
    readSnapshot: async () => { reads += 1; return { messagesVersion: "v1", state: { isStreaming: false } }; }, applySnapshot() {},
  });
  try {
    poll.start(); await wait(25); assert.equal(reads, 0);
    quiet = true; await until(() => reads === 2); await wait(25); assert.equal(reads, 2);
  } finally { poll.stop(); }
});

test("轻量快照不返回全文、不启动休眠Agent；思考增量不改变消息版本", async () => {
  const h = await sdkHarness();
  try {
    assert.equal(h.runtime.snapshot().messages, undefined); assert.equal(h.hosts.length, 0);
    await h.runtime.start();
    h.hosts[0].session.messages.push({ role: "assistant", content: "large".repeat(10000) });
    const first = h.runtime.snapshot(); assert.equal(first.messages, undefined);
    h.hosts[0].push({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "think" } });
    assert.equal(h.runtime.snapshot().messagesVersion, first.messagesVersion);
    h.hosts[0].push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "text" } });
    const next = h.runtime.snapshot({ messages: true, since: first.messagesVersion });
    assert.equal(next.messages.length, 1);
    assert.equal(h.runtime.snapshot({ messages: true, since: next.messagesVersion }).messages, undefined);
    await h.runtime.stop("idle"); h.runtime.snapshot(); assert.equal(h.hosts.length, 1);
  } finally { await h.cleanup(); }
});

test("消息回执只标记受理，不代表任务完成；重复ID不重复执行", async () => {
  const receipts = new PromptReceipts(), gate = deferred(); let calls = 0;
  const id = "request-1234567890";
  const operation = () => { calls += 1; return gate.promise; };
  const first = receipts.submit(id, { message: "hello" }, operation);
  const duplicate = receipts.submit(id, { message: "hello" }, operation);
  assert.equal(first, duplicate); assert.equal(receipts.get(id).status, "pending");
  assert.throws(() => receipts.submit(id, { message: "different" }, operation), /其他内容/);
  gate.resolve(null); await first;
  assert.equal(calls, 1); assert.equal(receipts.get(id).status, "accepted");
  assert.equal(receipts.get("missing").status, "unknown");
  const rejected = receipts.submit("request-rejected-123", {}, () => { throw new Error("preflight rejected"); });
  await assert.rejects(rejected); assert.equal(receipts.get("request-rejected-123").status, "rejected");
});

test("断线丢失ACK时先对账，不自动重发，未知状态明确告知", async () => {
  for (const status of ["accepted", "pending", "unknown"]) {
    let posts = 0, checks = 0;
    const client = createAgentClient({ request: async (name, args, options) => {
      if (name === "agent.receipt") { checks += 1; return { status }; }
      posts += 1; assert.equal(options.timeout, 0);
      assert.ok(args.requestId);
      throw new ApplicationError("操作已取消", { status: 499 });
    } });
    if (status === "accepted") await client.send("hello");
    else await assert.rejects(client.send("hello"), (error) => error.acceptanceUnknown && /勿重复发送/.test(error.message));
    assert.equal(posts, 1); assert.equal(checks, 1);
  }
});

test("IPC默认期限和显式期限可配置", async () => {
  const originalWindow = globalThis.window, originalSetTimeout = globalThis.setTimeout;
  const deadlines = [];
  globalThis.window = { workbench: { invoke: async () => ({ ok: true, value: {} }), cancel() {} } };
  globalThis.setTimeout = (callback, ms) => { deadlines.push(ms); return originalSetTimeout(callback, ms); };
  try {
    await invoke("system.status"); await invoke("agent.command", {}, { timeout: 0 }); await invoke("system.status", {}, { timeout: 500 });
    assert.deepEqual(deadlines, [120000, 500]);
  } finally { globalThis.window = originalWindow; globalThis.setTimeout = originalSetTimeout; }
});
