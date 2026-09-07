import test from "node:test";
import assert from "node:assert/strict";
import { api, ApiError, workspacePayload, workspaceUrl } from "../public/core/api-client.js";
import { createAgentClient } from "../public/core/agent-client.js";
import { createAgentEventStream } from "../public/core/event-stream.js";
import { createSessionService } from "../public/core/session-service.js";


class FakeEventSource {
  constructor(url) { this.url = url; this.closed = false; }
  close() { this.closed = true; }
}

test("共享API模块注入工作区并保留查询参数", () => {
  assert.equal(workspaceUrl("/api/sessions", "工作区 1"), "/api/sessions?workspaceId=%E5%B7%A5%E4%BD%9C%E5%8C%BA%201");
  assert.equal(workspaceUrl("/api/tree?depth=4", "w1"), "/api/tree?depth=4&workspaceId=w1");
  assert.deepEqual(workspacePayload({ type: "prompt" }, "w1"), { type: "prompt", workspaceId: "w1" });
  assert.deepEqual(workspacePayload({ type: "prompt" }, null), { type: "prompt" });
});

test("共享API模块统一解析错误并保留状态码", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "请求冲突" }), { status: 409, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(api("/api/test"), (error) => error instanceof ApiError && error.status === 409 && error.message === "请求冲突");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("共享API模块支持超时和调用方取消", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });
  try {
    await assert.rejects(api("/api/slow", { timeout: 5 }), /请求超时/);
    const controller = new AbortController();
    const pending = api("/api/cancel", { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /请求已取消/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SSE客户端只创建一个连接并统一解析事件", () => {
  const sources = [];
  const events = [];
  const statuses = [];
  const stream = createAgentEventStream({
    onEvent: (event) => events.push(event),
    onStatus: (status, detail) => statuses.push([status, detail.reconnected]),
    eventSourceFactory: (url) => { const source = new FakeEventSource(url); sources.push(source); return source; },
  });
  const first = stream.connect();
  assert.equal(stream.connect(), first);
  assert.equal(sources.length, 1);
  first.onopen();
  first.onmessage({ data: JSON.stringify({ type: "agent_start" }) });
  assert.deepEqual(events, [{ type: "agent_start" }]);
  first.onerror(new Error("断线"));
  stream.close();
  assert.equal(first.closed, true);
  assert.deepEqual(statuses.map(([status]) => status), ["connecting", "open", "reconnecting", "closed"]);
});

test("Agent客户端将首页和展开助手共用的事件归一为一致状态", () => {
  const client = createAgentClient({ request: async () => ({}) });
  assert.equal(client.applyEvent({ type: "agent_start" }).running, true);
  const settled = client.applyEvent({ type: "agent_settled" });
  assert.equal(settled.running, false);
  assert.equal(settled.streaming, false);
  assert.equal(settled.runtimeState, "ready");
  assert.equal(client.applyEvent({ type: "runtime_idle" }).runtimeState, "idle");
  assert.equal(client.applyEvent({ type: "runtime_exit" }).runtimeState, "error");
});

test("会话服务统一封装列表、新建、激活、改名、删除和消息同步", async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push([path, options]);
    if (path.startsWith("/api/sessions?")) return { sessions: [{ id: "s1" }] };
    return { activeDeleted: false };
  };
  const agentClient = {
    getState: async () => ({ sessionId: "s1", isStreaming: false }),
    getMessages: async () => ({ messages: [{ role: "user", content: "你好" }] }),
    applyAgentState: () => {},
  };
  const service = createSessionService({ request, agentClient, getWorkspaceId: () => "w1" });
  assert.deepEqual(await service.list(), [{ id: "s1" }]);
  await service.create();
  await service.activate("a.jsonl");
  await service.rename("a.jsonl", "新名称");
  await service.remove("a.jsonl");
  const synced = await service.syncCurrent();
  assert.equal(synced.state.sessionId, "s1");
  assert.equal(synced.messages.length, 1);
  assert.deepEqual(calls.map(([path]) => path), [
    "/api/sessions?workspaceId=w1",
    "/api/agent/new",
    "/api/sessions/activate",
    "/api/sessions/rename",
    "/api/sessions",
  ]);
  for (const [, options] of calls.slice(1)) assert.match(options.body, /"workspaceId":"w1"/);
});

