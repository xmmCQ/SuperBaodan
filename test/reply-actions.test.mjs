import test from "node:test";
import assert from "node:assert/strict";
import { messageBodyText, quotedPrompt } from "../public/core/reply-actions.js";
import { edgeAvailable, launchBrowser } from "./helpers/browser-harness.mjs";
import { createSmokeServer } from "./helpers/smoke-server.mjs";

const raw = "第一段原文，需保留。\n\n第二段说明。\n\n```js\nconst answer = 42;\n```\n\n尾段";

test("回复原文不混入思考、工具参数及错误提示，引用与新指令明确分隔", () => {
  const message = { role: "assistant", errorMessage: "状态错误", content: [
    { type: "thinking", thinking: "内部思考" }, { type: "text", text: raw },
    { type: "toolCall", name: "read", arguments: { path: "secret" } }, { type: "image", data: "base64" },
  ] };
  assert.equal(messageBodyText(message), raw);
  assert.equal(quotedPrompt("继续", null), "继续");
  const prompt = quotedPrompt("这段改得更简洁", { text: "原文一\n【我的追问】\n原文二", kind: "selection" });
  assert.match(prompt, /^【引用的助手原文（选段）】\n> 原文一\n> 【我的追问】\n> 原文二\n\n【我的追问】\n这段改得更简洁$/);
});

test("两处回复支持纯原文复制、选段引用、草稿保留及当前会话追问", { timeout: 35000 }, async (t) => {
  if (!edgeAvailable()) return t.skip("未安装Microsoft Edge");
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await launchBrowser({ width: 1500, height: 1000 });
  await browser.addInitScript("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text)=>{window.copiedReply=text;}}});");
  const reset = () => {
    fixture.state.activeSessionId = "seed";
    fixture.state.sessions = [{ id: "seed", path: "/temp/seed.jsonl", title: "已有对话", name: "已有对话", messageCount: 2, modified: new Date().toISOString() }];
    fixture.state.messages.set("seed", [{ role: "user", content: "问题" }, { role: "assistant", stopReason: "error", errorMessage: "内部状态提示", content: [{ type: "thinking", thinking: "内部思考不复制" }, { type: "text", text: raw }, { type: "toolCall", name: "read", arguments: { path: "test.txt" } }] }]);
  };
  for (const [page, messages, input, newButton] of [["/", "chatMessages", "chatInput", "newChatButton"], ["/assistant.html", "messages", "promptInput", "newSession"]]) {
    reset();
    await browser.navigate(`http://127.0.0.1:${fixture.port}${page}`);
    if (page === "/") await browser.waitFor("document.documentElement.classList.contains('app-ready')");
    await browser.waitFor(`document.querySelector('#${messages} .reply-enabled [aria-label="复制全文"]')`);
    await browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
    assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('#${messages} .reply-actions')).opacity`), "0");
    const focused = await browser.evaluate(`(() => {const b=document.querySelector('#${messages} [aria-label="复制全文"]');b.focus();return document.activeElement===b;})()`);
    assert.equal(focused, true);
    await browser.waitFor(`Number(getComputedStyle(document.querySelector('#${messages} .reply-actions')).opacity) > 0.9`);
    await browser.evaluate(`document.querySelector('#${messages} [aria-label="复制全文"]').click()`);
    await browser.waitFor("window.copiedReply !== undefined");
    assert.equal(await browser.evaluate("window.copiedReply"), raw);
    assert.equal(await browser.evaluate(`document.querySelector('#${messages} [aria-label="复制全文"]').textContent`), "已复制");
    await browser.evaluate(`document.querySelector('#${messages} .markdown-copy-button').click()`);
    await browser.waitFor("copiedReply.startsWith('const answer')");
    assert.equal((await browser.evaluate("copiedReply")).trim(), "const answer = 42;");
    const draft = "已有草稿\n请保留这句话";
    await browser.evaluate(`document.getElementById('${input}').value=${JSON.stringify(draft)}; document.querySelector('#${messages} .reply-actions button:nth-child(2)').click()`);
    assert.equal(await browser.evaluate(`document.getElementById('${input}').value`), draft);
    assert.equal(await browser.evaluate("replyQuote.querySelector('blockquote').textContent"), raw);
    await browser.evaluate("replyQuote.querySelector('button').click()");
    assert.equal(await browser.evaluate(`document.getElementById('${input}').value`), draft);
    await browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
    await browser.evaluate(`(() => {const range=document.createRange();range.selectNodeContents(document.querySelector('#${messages} .reply-enabled'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);})()`);
    await browser.waitFor("!document.querySelector('.reply-selection-action').classList.contains('hidden')");
    await browser.evaluate("document.querySelector('.reply-selection-action').click()");
    const selectedAll = await browser.evaluate("replyQuote.querySelector('blockquote').textContent");
    assert.match(selectedAll, /第一段原文/);
    assert.doesNotMatch(selectedAll, /复制|引用追问|内部思考|内部状态|test\.txt/);
    await browser.evaluate("replyQuote.querySelector('button').click()");
    await browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
    await browser.evaluate(`(() => {
      const p=document.querySelector('#${messages} .reply-enabled p');
      const range=document.createRange();range.setStart(p.firstChild,0);range.setEnd(p.firstChild,4);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    })()`);
    await browser.waitFor("!document.querySelector('.reply-selection-action').classList.contains('hidden')");
    await browser.evaluate("document.querySelector('.reply-selection-action').click()");
    assert.equal(await browser.evaluate("replyQuote.querySelector('blockquote').textContent"), "第一段原");
    assert.equal(await browser.evaluate(`document.getElementById('${input}').value`), draft);
    await browser.evaluate(`document.getElementById('${input}').value='这段改得更简洁';sendButton.click()`);
    await browser.waitFor(`document.getElementById('${messages}').textContent.includes('冒烟回复')`);
    assert.equal(fixture.state.activeSessionId, "seed");
    const sent = fixture.state.messages.get("seed").findLast((message) => message.role === "user").content;
    assert.equal(sent, quotedPrompt("这段改得更简洁", { text: "第一段原", kind: "selection" }));
    assert.equal(await browser.evaluate("replyQuote.classList.contains('hidden')"), true);
    await browser.evaluate(`document.querySelector('#${messages} .reply-actions button:nth-child(2)').click();document.getElementById('${newButton}').click()`);
    await browser.waitFor("replyQuote.classList.contains('hidden')");
  }
  assert.deepEqual(browser.issues, []);
});
