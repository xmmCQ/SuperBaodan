import assert from "node:assert/strict";
import test from "node:test";
import { edgeAvailable, launchBrowser } from "./helpers/browser-harness.mjs";
import { createSmokeServer } from "./helpers/smoke-server.mjs";

// 使用浏览器驱动测试内嵌页面，不提供独立浏览器产品入口。
test("内嵌页面不再提供退出按钮或旧关闭状态接口", { timeout: 30000 }, async (t) => {
  if (!edgeAvailable()) return t.skip("未安装 Microsoft Edge");
  const fixture = await createSmokeServer();
  t.after(() => fixture.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  for (const [url, input] of [["/", "chatInput"], ["/assistant.html", "promptInput"]]) {
    await browser.navigate(`http://127.0.0.1:${fixture.port}${url}`);
    await browser.waitFor(`Boolean(document.getElementById('${input}'))`);
    assert.equal(await browser.evaluate("Boolean(document.querySelector('#exitWorkbenchButton, #exitWorkbench'))"), false);
    assert.equal(await browser.evaluate("typeof window.workbenchRuntime"), "undefined");
    assert.equal(await browser.evaluate(`document.getElementById('${input}').value='未发送草稿'`), "未发送草稿");
  }
});
