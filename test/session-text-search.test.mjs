import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { searchSessionText } from "../lib/session-text-search.mjs";
import { createSessionSearch, searchStatus } from "../public/core/session-search.js";
import { deferred, wait } from "./helpers/fake-sdk-host.mjs";
import { createTempProject } from "./helpers/temp-project.mjs";

const message = (role, content, id) => ({ type: "message", id, timestamp: "2026-09-07T10:00:00Z", message: { role, content, timestamp: 1788775200000 } });
async function writeSession(temp, name, cwd, rows) {
  return temp.write(`sessions/${name}.jsonl`, [{ type: "session", id: name, cwd }, ...rows].map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("只匹配当前工作区用户/助手text，返回稳定记录定位及片段", async () => {
  const temp = await createTempProject();
  try {
    const cwd = temp.resolve("workspace");
    await writeSession(temp, "current", cwd, [
      message("user", [{ type: "text", text: "讨论贴现报价方案" }], "user-entry"),
      message("toolResult", [{ type: "text", text: "工具日志专属词" }], "tool-entry"),
      message("assistant", [{ type: "thinking", thinking: "思考专属词" }, { type: "image", data: "图片专属词" }, { type: "toolCall", arguments: { text: "参数专属词" } }, { type: "text", text: "贴现方案回复" }], "assistant-entry"),
      { type: "session_info", name: "会话名称" },
    ]);
    await writeSession(temp, "other", temp.resolve("other"), [message("user", "其他工作区贴现", "foreign")]);
    const options = { sessionDir: temp.resolve("sessions"), workspaceRoot: cwd };
    const result = await searchSessionText({ ...options, query: "贴现" });
    assert.equal(result.complete, true); assert.equal(result.hits.length, 2);
    assert.equal(result.hits[0].sessionId, "current"); assert.equal(result.hits[0].entryId, "user-entry");
    assert.equal(result.hits[0].lineNumber, 2); assert.equal(result.hits[0].messageIndex, 0);
    assert.equal(result.hits[1].messageIndex, 2); assert.equal(result.hits[1].title, "会话名称");
    assert.ok(result.hits.every((hit) => hit.timestamp && hit.snippet.includes("贴现")));
    for (const query of ["工具日志专属词", "思考专属词", "图片专属词", "参数专属词", "其他工作区"]) {
      assert.deepEqual((await searchSessionText({ ...options, query })).hits, []);
    }
  } finally { await temp.cleanup(); }
});

test("预算耗尽返回部分结果或不完整零结果，不能伪装成无结果", async () => {
  const temp = await createTempProject();
  try {
    const cwd = temp.resolve("workspace"), options = { sessionDir: temp.resolve("sessions"), workspaceRoot: cwd, query: "目标" };
    await writeSession(temp, "a", cwd, [message("user", "目标一", "1"), message("assistant", "目标二", "2")]);
    await writeSession(temp, "b", cwd, [message("user", "目标三", "3")]);
    const limited = await searchSessionText({ ...options, budget: { maxResults: 1 } });
    assert.equal(limited.complete, false); assert.equal(limited.hits.length, 1); assert.ok(limited.reasons.includes("result_budget"));
    const bytes = await searchSessionText({ ...options, budget: { maxBytes: 1 } });
    assert.equal(bytes.complete, false); assert.match(searchStatus(bytes), /结果未完整扫描/);
    assert.doesNotMatch(searchStatus(bytes), /未找到/);
    const files = await searchSessionText({ ...options, budget: { maxFiles: 1 } });
    assert.equal(files.complete, false); assert.ok(files.reasons.includes("file_budget"));
    const complete = await searchSessionText({ ...options, query: "不存在的词" });
    assert.equal(complete.complete, true); assert.match(searchStatus(complete), /未找到/);
  } finally { await temp.cleanup(); }
});

test("大Base64行不驻留内存，跳过时明确不完整且后续使用行号定位", async () => {
  const temp = await createTempProject();
  try {
    const cwd = temp.resolve("workspace");
    await writeSession(temp, "big", cwd, [
      message("user", [{ type: "image", data: "A".repeat(100000) }], "image"),
      message("assistant", "后续命中", "after"),
    ]);
    const result = await searchSessionText({ sessionDir: temp.resolve("sessions"), workspaceRoot: cwd, query: "后续命中", budget: { maxLineBytes: 1024 } });
    assert.equal(result.complete, false); assert.ok(result.reasons.includes("oversized_line"));
    assert.equal(result.hits[0].entryId, "after"); assert.equal(result.hits[0].lineNumber, 3);
    assert.equal(result.hits[0].messageIndex, null);
  } finally { await temp.cleanup(); }
});

test("旧搜索取消会停止扫描，外部编辑后新请求读取最新内容", async () => {
  const temp = await createTempProject();
  try {
    const cwd = temp.resolve("workspace");
    const file = await writeSession(temp, "a", cwd, [message("user", "旧文本", "old")]);
    const options = { sessionDir: temp.resolve("sessions"), workspaceRoot: cwd, query: "新文本" };
    const controller = new AbortController(); controller.abort();
    await assert.rejects(searchSessionText({ ...options, signal: controller.signal }), (error) => error.name === "AbortError");
    const inFlightController = new AbortController();
    const inFlight = searchSessionText({ ...options, signal: inFlightController.signal });
    inFlightController.abort();
    await assert.rejects(inFlight, (error) => error.name === "AbortError");
    assert.equal((await searchSessionText(options)).hits.length, 0);
    await writeFile(file, [{ type: "session", id: "a", cwd }, message("user", "新文本", "new")].map(JSON.stringify).join("\n") + "\n");
    assert.equal((await searchSessionText(options)).hits[0].entryId, "new");
  } finally { await temp.cleanup(); }
});

class SearchNode {
  value = ""; children = []; textContent = ""; listeners = new Map();
  classList = { toggle() {} };
  setAttribute() {}
  replaceChildren(...nodes) { this.children = nodes; }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
}

test("搜索输入变化取消旧请求，迟到响应不覆盖新查询", async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: () => new SearchNode() };
  const input = new SearchNode(), results = new SearchNode(), requests = [];
  const view = createSessionSearch({ input, results, defaultList: new SearchNode(), debounceMs: 0,
    search: (query, { signal }) => { const gate = deferred(); requests.push({ query, signal, gate }); return gate.promise; },
    onOpen() {},
  });
  const waitForRequests = async (count) => {
    for (let i = 0; requests.length < count && i < 100; i += 1) await wait(2);
    assert.equal(requests.length, count);
  };
  try {
    input.value = "旧查询"; view.refresh(); await waitForRequests(1);
    input.value = "新查询"; view.refresh(); await waitForRequests(2);
    assert.equal(requests[0].signal.aborted, true);
    requests[1].gate.resolve({ complete: false, hits: [] }); await wait(5);
    assert.match(results.children[0].textContent, /结果未完整扫描/);
    requests[0].gate.resolve({ complete: true, hits: [] }); await wait(5);
    assert.match(results.children[0].textContent, /结果未完整扫描/);
    input.value = ""; view.refresh(); assert.equal(results.children.length, 0);
  } finally { view.cancel(); globalThis.document = originalDocument; }
});
