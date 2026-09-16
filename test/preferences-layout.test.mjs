import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './helpers/browser-harness.mjs';

test('新对话默认设置并排紧凑展示，提示无背景，模型悬停显示全名', {timeout:20000}, async t => {
  if (!edgeAvailable()) return t.skip('需要 Edge');
  const fixture=await createSmokeServer(); let browser;
  t.after(async()=>{try {await browser?.close();} finally {await fixture.close();}});
  browser=await launchBrowser({width:1600,height:1000});
  await browser.navigate(`http://127.0.0.1:${fixture.port}/assistant.html`);
  await browser.waitFor("document.querySelectorAll('#messages > .message').length>=2");
  await browser.evaluate('settingsButton.click()');
  await browser.waitFor('settingsDialog.open');
  await browser.evaluate("document.querySelector('[data-settings-tab=preferences]').click()");
  await browser.waitFor("document.getElementById('defaultModelSelect').options.length>0");
  const layout=await browser.evaluate(`(()=>{
    const m=document.getElementById('defaultModelSelect'), t=document.getElementById('defaultThinking'), note=document.querySelector('#preferencesTab .settings-scope-note');
    const a=m.getBoundingClientRect(), b=t.getBoundingClientRect();
    return {sameRow:Math.abs(a.top-b.top)<1,height:a.height,thinkingWidth:b.width,separate:a.right<b.left,title:m.title,name:m.selectedOptions[0].textContent,background:getComputedStyle(note).backgroundColor,noteBelow:note.getBoundingClientRect().top>=a.bottom};
  })()`);
  assert.equal(layout.sameRow,true); assert.equal(layout.height,32); assert.equal(layout.thinkingWidth,140);
  assert.equal(layout.separate,true); assert.equal(layout.title,layout.name);
  assert.equal(layout.background,'rgba(0, 0, 0, 0)'); assert.equal(layout.noteBelow,true);
});
