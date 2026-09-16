import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './helpers/browser-harness.mjs';

test('文档入口编辑器隐藏空提示并收紧底部，有提示时正常展开', { timeout: 20000 }, async t => {
  if (!edgeAvailable()) return t.skip('需要 Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await launchBrowser({ width: 1600, height: 1000 });
  await browser.navigate(`http://127.0.0.1:${fixture.port}/`);
  await browser.waitFor("document.documentElement.classList.contains('app-ready')");
  await browser.evaluate('workDocumentsButton.click()');
  await browser.waitFor("document.querySelector('.wd-toolbar .wd-primary')?.disabled===false");
  await browser.evaluate("document.querySelector('.wd-toolbar .wd-primary').click()");
  const layout = await browser.evaluate(`(()=>{
    const editor=document.querySelector('.wd-editor[open]'), footer=editor.querySelector('.wd-footer');
    return {
      emptyNotice:getComputedStyle(editor.querySelector('.wd-notice')).display,
      emptyPicker:getComputedStyle(editor.querySelector('.wd-picker-status')).display,
      gap:footer.getBoundingClientRect().top-editor.querySelector('fieldset').getBoundingClientRect().bottom,
      width:editor.getBoundingClientRect().width,
      height:editor.getBoundingClientRect().height,
    };
  })()`);
  assert.equal(layout.emptyNotice, 'none'); assert.equal(layout.emptyPicker, 'none');
  assert.ok(layout.gap >= 12 && layout.gap <= 17, `底部间距：${layout.gap}`);
  assert.equal(layout.width, 480);
  assert.ok(layout.height <= 440, `弹窗高度：${layout.height}`);
  await browser.evaluate(`(()=>{const e=document.querySelector('.wd-editor[open]');e.querySelector('.wd-notice').textContent='保存失败';e.querySelector('.wd-picker-status').textContent='请选择文件';})()`);
  await browser.waitFor("[...document.querySelectorAll('.wd-editor[open] .wd-notice,.wd-editor[open] .wd-picker-status')].every(el=>getComputedStyle(el).display!=='none' && el.getBoundingClientRect().height>0)");
});
