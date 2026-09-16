import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './helpers/browser-harness.mjs';

test('六个设置页长内容滚动不被保存栏遮挡，底部可完整到达', {timeout:30000}, async t => {
  if (!edgeAvailable()) return t.skip('需要 Edge');
  const fixture=await createSmokeServer(); let browser;
  t.after(async()=>{try {await browser?.close();} finally {await fixture.close();}});
  browser=await launchBrowser({width:1400,height:760});
  await browser.navigate(`http://127.0.0.1:${fixture.port}/assistant.html`);
  await browser.waitFor("document.querySelectorAll('#messages > .message').length>=2");
  await browser.evaluate('settingsButton.click()');
  await browser.waitFor("settingsDialog.open && document.querySelectorAll('#oauthProviders .provider-card').length>0");
  for (const tab of ['accounts','custom','preferences','projectPrompt','skills','reading']) {
    await browser.evaluate(`document.querySelector('[data-settings-tab=${tab}]').click()`);
    await browser.waitFor(`document.getElementById('${tab}Tab').classList.contains('active')`);
    const result=await browser.evaluate(`(async()=>{
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const tab=document.querySelector('#settingsDialog > .settings-tab.active');
      const scroll=tab.id==='skillsTab'?document.getElementById('skillsDetail'):tab;
      const footer=scroll.querySelector(':scope > .dialog-actions');
      const probe=document.createElement('div');probe.style.cssText='height:1400px;min-height:1400px;flex:none';
      scroll.insertBefore(probe, footer || null);
      const overlap=[];
      for (const fraction of [0,.3,.65,1]) {
        scroll.scrollTop=(scroll.scrollHeight-scroll.clientHeight)*fraction;
        await new Promise(requestAnimationFrame);
        const a=footer?.getBoundingClientRect(), b=probe.getBoundingClientRect();
        overlap.push(Boolean(a && a.top<b.bottom-.5 && a.bottom>b.top+.5));
      }
      const s=scroll.getBoundingClientRect(), last=(footer || probe).getBoundingClientRect();
      const panel=tab.getBoundingClientRect(),dialog=settingsDialog.getBoundingClientRect();
      const result={overlap:overlap.some(Boolean),lastVisible:last.bottom<=s.bottom+1,withinDialog:panel.bottom<=dialog.bottom+1,position:footer?getComputedStyle(footer).position:'none',hasScrollbar:scroll.scrollHeight>scroll.clientHeight};
      probe.remove();scroll.scrollTop=0;return result;
    })()`);
    assert.equal(result.overlap,false,`${tab}: 保存栏覆盖内容`);
    assert.equal(result.hasScrollbar,true,`${tab}: 未形成长内容场景`);
    assert.equal(result.lastVisible,true,`${tab}: 底部不可见`);
    assert.equal(result.withinDialog,true,`${tab}: 内容超出弹窗`);
    assert.ok(['none','static'].includes(result.position),`${tab}: 保存栏悬浮`);
  }
});
