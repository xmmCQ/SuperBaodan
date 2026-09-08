import test from "node:test";
import assert from "node:assert/strict";
import { executionLabel } from "../public/core/execution-process.js";
import { edgeAvailable, launchBrowser } from "./helpers/browser-harness.mjs";
import { createSmokeServer } from "./helpers/smoke-server.mjs";

test("执行状态只依据实际终态和事件，不把停止、重试或未知当成功", () => {
  assert.equal(executionLabel(null, { stopReason: "stop" }), "已完成");
  assert.equal(executionLabel("retrying", { stopReason: "error" }), "正在重试");
  assert.equal(executionLabel("stopping", {}), "正在停止");
  assert.equal(executionLabel(null, { stopReason: "aborted" }), "已停止");
  assert.equal(executionLabel(null, { stopReason: "error" }), "执行失败");
  assert.match(executionLabel(null, {}), /未确认/);
  assert.match(executionLabel(null, { stopReason: "stop" }, 1), /已完成.*失败步骤/);
});
const paint = (browser) => browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");

test("执行细节按轮次收起，手动展开跨流式/快照保持，失败可追查", { timeout: 30000 }, async (t) => {
  if (!edgeAvailable()) return t.skip("未安装Microsoft Edge");
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  const original = [
    { role: "user", timestamp: 100, content: "读取并保存资料" },
    { role: "assistant", timestamp: 101, stopReason: "toolUse", content: [{ type: "thinking", thinking: "内部思考" }, { type: "text", text: "## 实际读取说明\n" + "读取说明。".repeat(70) }, { type: "toolCall", id: "read-1", name: "read", arguments: { path: "input.md" } }] },
    { role: "toolResult", timestamp: 102, toolCallId: "read-1", toolName: "read", isError: false, content: [{ type: "text", text: "读取日志\n".repeat(300) + "日志末尾标记" }] },
    { role: "assistant", timestamp: 103, stopReason: "toolUse", content: [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "output.md", content: "内容" } }] },
    { role: "toolResult", timestamp: 104, toolCallId: "write-1", toolName: "write", isError: false, content: [{ type: "text", text: "保存完成" }] },
    { role: "assistant", timestamp: 105, stopReason: "stop", content: [{ type: "text", text: "最终回答\n\n" + "正文段落。\n\n".repeat(65) }] },
  ];
  fixture.state.messages.set("seed", original);
  const emit = (event) => { for (const res of fixture.state.eventClients) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  browser = await launchBrowser({ width: 1600, height: 1000 });
  await browser.navigate(`http://127.0.0.1:${fixture.port}/assistant.html`);
  await browser.waitFor("document.querySelector('.execution-label')?.textContent.includes('已完成')"); await paint(browser);
  assert.equal(await browser.evaluate("document.querySelectorAll('.execution-process').length"), 1);
  assert.equal(await browser.evaluate("document.querySelector('.execution-process').open"), false);
  assert.match(await browser.evaluate("document.querySelector('.execution-label').textContent"), /已确认修改 1 个文件/);
  assert.equal(await browser.evaluate("document.querySelectorAll('#messages > .message:not(.execution-source)').length"), 2);
  assert.equal(await browser.evaluate("document.querySelector('.execution-steps').textContent.includes('日志末尾标记')"), true);
  assert.equal(await browser.evaluate("document.querySelector('#messages > .message:last-child > .message-inner > .bubble > .markdown-body').textContent.includes('最终回答')"), true);
  // A directory target moved into the drawer must be revealed before scrolling.
  await browser.evaluate("directoryButton.click()");
  await browser.waitFor("document.querySelector('[data-directory-key=\"heading-1-0\"]')");
  await browser.evaluate("document.querySelector('[data-directory-key=\"heading-1-0\"]').click()"); await paint(browser);
  assert.equal(await browser.evaluate("document.querySelector('.execution-process').open"), true);
  const offset = await browser.evaluate("document.querySelector('[data-execution-message-index=\"1\"] h2').getBoundingClientRect().top-messages.getBoundingClientRect().top");
  assert.ok(offset >= 0 && offset < await browser.evaluate('messages.clientHeight'), `标题应在可见范围内：${offset}`);
  if (Math.abs(offset-12) >= 3) assert.ok(await browser.evaluate('messages.scrollHeight-messages.clientHeight-messages.scrollTop < 3'));
  await browser.evaluate("conversationDirectory.querySelector('[data-close]').click(); document.querySelector('.tool-card > summary').click()");
  await browser.evaluate("document.querySelector('.execution-result > summary').click(); document.querySelector('.execution-result .tool-result').scrollTop=300; window.beforeSync=messages.lastElementChild");
  emit({ type: "agent_settled" });
  await browser.waitFor("messages.lastElementChild!==window.beforeSync && document.querySelector('.tool-card').open"); await paint(browser);
  assert.equal(await browser.evaluate("document.querySelector('.execution-result .tool-result').scrollTop"), 300);
  await browser.evaluate("messages.style.scrollBehavior='auto';messages.scrollTop=100"); await paint(browser);
  const top = await browser.evaluate("messages.scrollTop");
  emit({ type: "agent_start" });
  emit({ type: "message_start", message: { role: "assistant", timestamp: 106, content: [] } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "新的正文" } });
  await browser.waitFor("messages.textContent.includes('新的正文')"); await paint(browser);
  assert.equal(await browser.evaluate("document.querySelector('.execution-process').open && document.querySelector('.tool-card').open"), true);
  assert.equal(await browser.evaluate("messages.scrollTop"), top);
  emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
  await browser.waitFor("document.querySelector('.execution-label').textContent.includes('正在重试')");
  emit({ type: "auto_retry_end", success: false });
  await browser.waitFor("document.querySelector('.execution-label').textContent.includes('执行失败')");
  const failed = original.map((message) => message.toolCallId === "write-1" ? { ...message, isError: true, content: [{ type: "text", text: "磁盘不可写，保存失败" }] } : message);
  fixture.state.messages.set("seed", failed);
  emit({ type: "agent_settled" });
  await browser.waitFor("document.querySelector('.execution-result.execution-failure')?.textContent.includes('磁盘不可写')");
  await browser.evaluate("document.querySelector('.execution-process > summary').click()");
  assert.equal(await browser.evaluate("document.querySelector('.execution-process').open"), false);
  await browser.evaluate("window.beforeSync=messages.lastElementChild");
  emit({ type: "agent_settled" });
  await browser.waitFor("messages.lastElementChild!==window.beforeSync"); await paint(browser);
  assert.equal(await browser.evaluate("document.querySelector('.execution-process').open"), false);
  assert.match(await browser.evaluate("document.querySelector('.execution-label').textContent"), /失败/);
  assert.doesNotMatch(await browser.evaluate("document.querySelector('.execution-label').textContent"), /已确认修改/);
  fixture.state.messages.set('seed', [...original, ...Array.from({ length: 140 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i % 2 ? [{ type: 'text', text: `后续回答${i}` }] : `后续问题${i}` }))]);
  await browser.navigate(`http://127.0.0.1:${fixture.port}/assistant.html?older-process=1`);
  await browser.waitFor("document.querySelectorAll('#messages > .message').length===50");
  await browser.evaluate('directoryButton.click()');
  await browser.waitFor("document.querySelector('[data-directory-key=\"heading-1-0\"]')");
  await browser.evaluate("document.querySelector('[data-directory-key=\"heading-1-0\"]').click()");
  await browser.waitFor("document.querySelectorAll('#messages > .message').length===146"); await paint(browser);
  assert.equal(await browser.evaluate("document.querySelector('.execution-process').open"), true);
  assert.ok(await browser.evaluate("Math.abs(document.querySelector('[data-execution-message-index=\"1\"] h2').getBoundingClientRect().top-messages.getBoundingClientRect().top-12)<3"));
  assert.deepEqual(browser.issues, []);
});
