import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildConversationOutline, questionLabel, replyHeadings } from "../public/core/conversation-directory.js";
import { quotedPrompt } from "../public/core/reply-actions.js";
import { edgeAvailable, launchBrowser } from "./helpers/browser-harness.mjs";
import { createSmokeServer } from "./helpers/smoke-server.mjs";

const sandbox = {};
vm.runInNewContext(await readFile(new URL("../public/vendor/markdown-it-14.1.0.min.js", import.meta.url), "utf8"), sandbox);
const engine = sandbox.markdownit({ html: false });
const parse = (text) => engine.parse(text, {});
const report = (i) => `# 一级标题 ${i}\n\n${"长篇报告内容。".repeat(35)}\n\n## 二级标题 ${i}\n\n${"进一步说明。".repeat(35)}\n\n### 不进目录的三级标题\n\n\`\`\`md\n# 代码里的假标题\n\`\`\``;

test("目录按用户提问分轮次，仅收集真实一二级标题并缓存解析", () => {
  const cache = new Map(); let parses = 0;
  const parser = (text) => { parses += 1; return parse(text); };
  const messages = [
    { role: "user", content: "第一问" },
    { role: "assistant", content: [{ type: "thinking", thinking: "# 不进目录" }, { type: "text", text: report(1) }] },
    { role: "toolResult", content: "# 工具日志不进目录" },
    { role: "user", content: quotedPrompt("这段改得更简洁", { text: "旧原文", kind: "full" }) },
    { role: "assistant", content: [{ type: "text", text: "简短回答" }] },
  ];
  const turns = buildConversationOutline(messages, parser, cache);
  assert.equal(turns.length, 2); assert.equal(turns[0].index, 0); assert.equal(turns[1].index, 3);
  assert.equal(turns[1].label, "这段改得更简洁");
  assert.deepEqual(turns[0].headings.map((item) => [item.level, item.text, item.index]), [[1, "一级标题 1", 1], [2, "二级标题 1", 1]]);
  buildConversationOutline(messages, parser, cache); assert.equal(parses, 1);
  assert.equal(replyHeadings("# 标题\n" + "很长".repeat(110000), parser).length, 0);
  assert.ok(questionLabel("").includes("图片"));
  const split = buildConversationOutline([{ role: "user", content: "问题" }, { role: "assistant", content: [
    { type: "text", text: "# 第一标题\n正文" }, { type: "toolCall", name: "read" },
    { type: "text", text: "## 第二标题\n正文" },
  ] }], parser, new Map(), { splitTextBlocks: true });
  assert.deepEqual(split[0].headings.map((item) => [item.text, item.ordinal]), [["第一标题", 0], ["第二标题", 1]]);
});

const paint = (browser) => browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
test("两处目录先加载历史再定位标题，标识当前轮次，新消息不打断阅读", { timeout: 35000 }, async (t) => {
  if (!edgeAvailable()) return t.skip("未安装Microsoft Edge");
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await launchBrowser({ width: 1600, height: 1000 });
  const original = Array.from({ length: 140 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: i % 2 ? [{ type: "text", text: report((i - 1) / 2) }] : `第${i / 2}问` }));
  for (const [page, id] of [["/", "chatMessages"], ["/assistant.html", "messages"]]) {
    fixture.state.messages.set("seed", original.slice());
    await browser.navigate(`http://127.0.0.1:${fixture.port}${page}?directory=1`);
    if (page === "/") await browser.waitFor("document.documentElement.classList.contains('app-ready')");
    await browser.waitFor(`document.querySelectorAll('#${id} > .message').length === 50`); await paint(browser);
    assert.equal(await browser.evaluate("directoryButton.getAttribute('aria-expanded')"), "false");
    assert.equal(await browser.evaluate("conversationDirectory.classList.contains('hidden')"), true);
    assert.equal(await browser.evaluate(`(() => {const header=document.querySelector('${page === "/" ? ".chat-header" : ".toolbar"}');return header.scrollWidth <= header.clientWidth+1;})()`), true);
    await browser.evaluate("directoryButton.click()");
    await browser.waitFor("document.querySelectorAll('.directory-question').length === 70");
    assert.equal(await browser.evaluate("document.querySelectorAll('.directory-heading').length"), 140);
    assert.equal(await browser.evaluate(`Boolean(document.querySelector('#${id} > [data-message-index="0"]'))`), false);
    await browser.evaluate("document.querySelector('[data-turn-index=\"0\"]').click()");
    await browser.waitFor(`document.querySelectorAll('#${id} > .message').length === 140`); await paint(browser);
    assert.equal(await browser.evaluate("document.querySelector('.directory-question.is-current').dataset.turnIndex"), "0");
    await browser.evaluate("document.querySelector('[data-directory-key=\"heading-1-1\"]').click()"); await paint(browser);
    const headingOffset = await browser.evaluate(`document.querySelector('#${id} > [data-message-index="1"] h2').getBoundingClientRect().top-document.getElementById('${id}').getBoundingClientRect().top`);
    assert.ok(Math.abs(headingOffset - 12) < 3, `${page} 标题偏移 ${headingOffset}`);
    const top = await browser.evaluate(`document.getElementById('${id}').scrollTop`);
    const answer = { role: "assistant", content: [{ type: "text", text: "新到达的最新回复" }] };
    fixture.state.messages.set("seed", [...original, { role: "user", content: "新问题" }, answer]);
    for (const event of [
      { type: "agent_start" }, { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "新到达的最新回复" } },
      { type: "message_end", message: answer }, { type: "agent_settled" },
    ]) for (const res of fixture.state.eventClients) res.write(`data: ${JSON.stringify(event)}\n\n`);
    await browser.waitFor("document.querySelectorAll('.directory-question').length === 71"); await paint(browser);
    assert.equal(await browser.evaluate(`document.getElementById('${id}').scrollTop`), top);
    assert.equal(await browser.evaluate("document.querySelector('.directory-question.is-current').dataset.turnIndex"), "0");
    await browser.evaluate("conversationDirectory.querySelector('[data-latest]').click()"); await paint(browser);
    await browser.waitFor(`document.getElementById('${id}').scrollHeight-document.getElementById('${id}').clientHeight-document.getElementById('${id}').scrollTop < 3`);
    await browser.waitFor("document.querySelector('.directory-question.is-current').dataset.turnIndex === '140'");
    await browser.evaluate("conversationDirectory.querySelector('[data-close]').click()");
    assert.equal(await browser.evaluate("directoryButton.getAttribute('aria-expanded')"), "false");
  }
  assert.deepEqual(browser.issues, []);
});
