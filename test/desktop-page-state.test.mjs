import assert from "node:assert/strict";
import test from "node:test";
import { edgeAvailable, launchBrowser } from "./helpers/browser-harness.mjs";
import { createSmokeServer } from "./helpers/smoke-server.mjs";

test("页面关闭状态识别草稿，取消退出后保持输入内容", { timeout: 30000 }, async (t) => {
  if (!edgeAvailable()) return t.skip("未安装 Microsoft Edge");
  const fixture = await createSmokeServer(); const browser = await launchBrowser();
  t.after(async () => { await browser.close(); await fixture.close(); });

  await browser.navigate(`http://127.0.0.1:${fixture.port}/`);
  await browser.waitFor("!document.documentElement.classList.contains('app-loading')");
  await browser.evaluate("chatInput.value='未发送首页草稿';chatInput.dispatchEvent(new Event('input',{bubbles:true}))");
  const home = await browser.evaluate("superBaodanDesktopRuntime.getCloseState()");
  assert.equal(home.unsaved, true); assert.ok(home.reasons.some((item) => item.includes("未发送")));
  const cancelled = await browser.evaluate("superBaodanDesktopRuntime.requestExit({confirmBrowser:async()=>false,shutdownBrowser:async()=>{window.shutdownCalled=true}})");
  assert.equal(cancelled.cancelled, true); assert.equal(await browser.evaluate("chatInput.value"), "未发送首页草稿");
  assert.equal(await browser.evaluate("Boolean(window.shutdownCalled)"), false);

  await browser.navigate(`http://127.0.0.1:${fixture.port}/assistant.html`);
  await browser.waitFor("document.getElementById('promptInput') && !document.body.hasAttribute('aria-busy')").catch(() => {});
  await browser.evaluate("promptInput.value='未发送助手草稿';promptInput.dispatchEvent(new Event('input',{bubbles:true}))");
  const assistant = await browser.evaluate("superBaodanDesktopRuntime.getCloseState()");
  assert.equal(assistant.unsaved, true); assert.ok(assistant.reasons.some((item) => item.includes("未发送")));
});
