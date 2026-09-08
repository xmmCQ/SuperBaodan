import test from "node:test";
import assert from "node:assert/strict";
import { createMessageWindow, VISIBLE_PAGE_SIZE } from "../public/core/chat-lazy-load.js";
import { edgeAvailable, launchBrowser } from "./helpers/browser-harness.mjs";
import { createSmokeServer } from "./helpers/smoke-server.mjs";

test("可见窗口每页50条，同会话增长保留已加载历史，新会话重置", () => {
  const window = createMessageWindow();
  const items = Array.from({ length: 140 }, (_, i) => i);
  assert.equal(VISIBLE_PAGE_SIZE, 50);
  assert.deepEqual(window.update(items).messages, items.slice(90));
  assert.deepEqual(window.previous().messages, items.slice(40, 90));
  assert.equal(window.update([...items, 140, 141], { reset: false }).start, 40);
  assert.deepEqual(window.previous().messages, items.slice(0, 40));
  assert.equal(window.hasPrevious(), false);
  assert.equal(window.update(items).start, 90);
  assert.equal(window.update([1, 2], { reset: false }).start, 0);
  window.clear(); assert.equal(window.hasPrevious(), false);
});

test("首页和展开助手分页追加、保持锚点、流式消息不拉走阅读位置", { timeout: 30000 }, async (t) => {
  if (!edgeAvailable()) return t.skip("未安装Microsoft Edge");
  const fixture = await createSmokeServer();
  const browser = await launchBrowser();
  t.after(async () => { await browser.close(); await fixture.close(); });
  fixture.state.messages.set("seed", Array.from({ length: 140 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `分页消息 ${i}：${"足够长的历史内容。".repeat(12)}` }],
  })));
  for (const [page, id] of [["/", "chatMessages"], ["/assistant.html", "messages"]]) {
    await browser.navigate(`http://127.0.0.1:${fixture.port}${page}?lazy=1`);
    await browser.waitFor(`document.querySelectorAll('#${id} > .message').length === 50`);
    await browser.waitFor(`document.getElementById('${id}').scrollTop > 100`);
    for (const expected of [100, 140]) {
      await browser.evaluate(`(() => {
        const box=document.getElementById('${id}');
        box.scrollTop=0;
        window.lazyAnchor=box.querySelector('.message');
        window.lazyAnchorTop=lazyAnchor.getBoundingClientRect().top;
      })()`);
      await browser.waitFor(`document.querySelectorAll('#${id} > .message').length === ${expected}`);
      const delta = await browser.evaluate("Math.abs(lazyAnchor.getBoundingClientRect().top-lazyAnchorTop)");
      assert.ok(delta < 2, `${page} 锚点偏移 ${delta}`);
      assert.equal(await browser.evaluate("lazyAnchor.isConnected"), true);
    }
    await browser.evaluate(`document.getElementById('${id}').scrollTop=100`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const before = await browser.evaluate(`document.getElementById('${id}').scrollTop`);
    for (const event of [
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "流式新增内容" } },
    ]) for (const client of fixture.state.eventClients) client.write(`data: ${JSON.stringify(event)}\n\n`);
    await browser.waitFor(`document.querySelectorAll('#${id} > .message').length === 141`);
    assert.equal(await browser.evaluate(`document.getElementById('${id}').scrollTop`), before);
    // Reload discards the expanded window and starts again at the latest 50.
    await browser.navigate(`http://127.0.0.1:${fixture.port}${page}?lazy=reload`);
    try { await browser.waitFor(`document.querySelectorAll('#${id} > .message').length === 50`); }
    catch (error) {
      const ui = await browser.evaluate(`({url:location.href,count:document.querySelectorAll('#${id} > .message').length,top:document.getElementById('${id}').scrollTop,ready:document.readyState})`);
      throw new Error(`${error.message}; ${JSON.stringify({ ui, issues: browser.issues })}`);
    }
  }
  assert.deepEqual(browser.issues, []);
});
