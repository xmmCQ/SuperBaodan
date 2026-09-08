import test from "node:test";
import assert from "node:assert/strict";
import { edgeAvailable, launchBrowser } from "./helpers/browser-harness.mjs";
import { createSmokeServer } from "./helpers/smoke-server.mjs";

test("两处正文搜索展示片段及定位，区分预算不足与无结果，可打开会话", { timeout: 30000 }, async (t) => {
  if (!edgeAvailable()) return t.skip("未安装Microsoft Edge");
  const fixture = await createSmokeServer(), browser = await launchBrowser();
  t.after(async () => { await browser.close(); await fixture.close(); });
  fixture.state.searchReply = async (query) => {
    if (query === "预算") return { complete: false, reasons: ["byte_budget"], hits: [] };
    if (query === "空白") return { complete: true, hits: [] };
    return { complete: true, hits: [{ sessionId: "seed", sessionPath: "/temp/seed.jsonl", title: "已有对话", entryId: "entry", messageIndex: 1, lineNumber: 3, role: "assistant", timestamp: "2026-09-07T10:00:00Z", snippet: "正文命中片段 <b>不是HTML</b>" }] };
  };
  for (const [page, input, results, list] of [
    ["/", "historySearchInput", "historySearchResults", "chatHistoryList"],
    ["/assistant.html", "sessionSearch", "sessionSearchResults", "sessionList"],
  ]) {
    await browser.navigate(`http://127.0.0.1:${fixture.port}${page}`);
    if (page === "/") {
      await browser.waitFor("document.documentElement.classList.contains('app-ready')");
      await browser.evaluate("openChatHistoryButton.click()");
    } else await browser.waitFor("modelPickerButton.textContent.includes('GPT Test')");
    const enter = (text) => browser.evaluate(`(() => { const input=document.getElementById('${input}');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await enter("预算");
    await browser.waitFor(`document.getElementById('${results}').innerText.includes('结果未完整扫描')`);
    assert.equal(await browser.evaluate(`document.getElementById('${results}').innerText.includes('未找到')`), false);
    await enter("正文");
    await browser.waitFor(`document.querySelectorAll('#${results} .session-search-hit').length === 1`);
    assert.ok((await browser.evaluate(`document.getElementById('${results}').innerText`)).includes("第2条消息"));
    assert.equal(await browser.evaluate(`document.querySelector('#${results} .session-search-hit span').innerHTML.includes('&lt;b&gt;')`), true);
    await browser.evaluate(`document.querySelector('#${results} .session-search-hit').click()`);
    await browser.waitFor(`document.querySelector('#${results} .session-search-hit')?.disabled === false`);
    await enter("空白");
    await browser.waitFor(`document.getElementById('${results}').innerText.includes('未找到')`);
    await enter("");
    assert.equal(await browser.evaluate(`document.getElementById('${list}').classList.contains('hidden')`), false);
  }
  assert.ok(fixture.state.operations.includes("session:activate"));
  assert.deepEqual(browser.issues, []);
});
