import test from 'node:test';
import assert from 'node:assert/strict';
import { browserScenario, paint, settingsTab } from './helpers/browser-scenario.mjs';

test('设置紧凑框架、短表单、卡片同行与高级字段折叠保留值', { timeout: 35000 }, async t => {
  const scenario = await browserScenario(t); if (!scenario) return;
  const { browser, navigate, shot } = scenario;
  await browser.addInitScript(`
    const original=fetch; let config={providers:{demo:{name:'示例供应商',baseUrl:'https://example.invalid/v1',api:'openai-completions',headers:{'X-Test':'initial'},models:[{id:'demo',name:'示例模型',cost:{input:1,output:2,cacheRead:3,cacheWrite:4},compat:{sample:true}}]}}};
    window.fetch=(...args)=>{if(String(args[0])==='/api/models/config'){
      if(args[1]?.method && args[1].method!=='GET') {config=JSON.parse(args[1].body);window.savedConfig=config;}
      return Promise.resolve(new Response(JSON.stringify(config),{headers:{'Content-Type':'application/json'}}));
    }return original(...args);};
  `);
  await navigate();
  await browser.evaluate('settingsButton.click()'); await browser.waitFor('settingsDialog.open');
  await paint(browser);
  assert.deepEqual(await browser.evaluate('(()=>{const r=settingsDialog.getBoundingClientRect();return [r.width,r.height]})()'),[920,680]);
  const bounds = await browser.evaluate('(()=>{const r=settingsDialog.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()');
  assert.deepEqual(await browser.evaluate("[getComputedStyle(settingsDialog.querySelector('.dialog-head b')).fontSize,closeSettings.getBoundingClientRect().width]"), ['20px',36]);
  for (const tab of ['accounts','preferences','projectPrompt','skills','reading','custom']) {
    await settingsTab(browser, tab);
    assert.deepEqual(await browser.evaluate('(()=>{const r=settingsDialog.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()'),bounds,tab);
    if(tab==='custom') await browser.waitFor('providerConfigSelect.options.length>0');
    await paint(browser);
    assert.ok(await browser.evaluate(`(()=>{const t=document.getElementById('${tab}Tab');return t.scrollWidth<=t.clientWidth+1})()`),tab);
    await shot(tab);
    if(tab==='reading') assert.deepEqual(await browser.evaluate("(()=>{const r=document.querySelector('.reading-settings-inline select').getBoundingClientRect();return [r.width,r.height]})()"),[240,36]);
    if(tab==='preferences') {
      assert.ok(await browser.evaluate('defaultModelSelect.getBoundingClientRect().width<=428 && defaultThinking.getBoundingClientRect().width===160'));
      assert.deepEqual(await browser.evaluate("[getComputedStyle(preferencesTab.querySelector('h3')).fontSize,defaultModelSelect.getBoundingClientRect().height,defaultThinking.getBoundingClientRect().height]"),['16px',36,36]);
    }
    if(tab==='accounts') assert.ok(await browser.evaluate("[...document.querySelectorAll('#oauthProviders .provider-card')].every(c=>{const a=c.querySelector('.provider-card-actions').getBoundingClientRect(),h=c.querySelector('.provider-card-head').getBoundingClientRect();return c.getBoundingClientRect().height<=72 && a.left>=h.right})"));
  }
  await browser.waitFor('providerConfigSelect.options.length>0');
  assert.equal(await browser.evaluate("document.querySelectorAll('.config-advanced:not([open])').length"),3);
  await browser.evaluate("providerHeaders.closest('details').open=true;providerHeaders.value='{\"X-Test\":\"preserved\"}';providerHeaders.dispatchEvent(new Event('input',{bubbles:true}));providerHeaders.closest('details').open=false;providerHeaders.closest('details').open=true");
  assert.equal(await browser.evaluate('providerHeaders.value'),'{"X-Test":"preserved"}');
  assert.ok(await browser.evaluate('providerHeaders.getBoundingClientRect().height>0'));
  await browser.evaluate("providerHeaders.closest('details').open=false;saveModelsConfig.click()");
  await browser.waitFor('window.savedConfig');
  assert.deepEqual(await browser.evaluate('savedConfig.providers.demo.headers'), {'X-Test':'preserved'});
  assert.deepEqual(await browser.evaluate('savedConfig.providers.demo.models[0].cost'), {input:1,output:2,cacheRead:3,cacheWrite:4});
  assert.deepEqual(await browser.evaluate('savedConfig.providers.demo.models[0].compat'), {sample:true});
  await browser.setViewport(950,606); await paint(browser);
  assert.ok(await browser.evaluate('(()=>{const r=settingsDialog.getBoundingClientRect();return r.width<=902&&r.height<=558&&r.top>=0&&r.bottom<=innerHeight&&customTab.scrollWidth<=customTab.clientWidth+1})()'));
  assert.deepEqual(browser.issues, []);
});

test('六个设置页长内容滚动不被保存栏遮挡，底部可完整到达', {timeout:30000}, async t => {
  const scenario = await browserScenario(t, { width:1400, height:760 }); if (!scenario) return;
  const { browser, navigate } = scenario; await navigate();
  for (const tab of ['accounts','custom','preferences','projectPrompt','skills','reading']) {
    await settingsTab(browser, tab);
    const result=await browser.evaluate(`(async()=>{
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
  assert.deepEqual(browser.issues, []);
});

test('新对话默认设置并排紧凑展示，提示无背景，模型悬停显示全名', {timeout:20000}, async t => {
  const scenario = await browserScenario(t, { width:1600, height:1000 }); if (!scenario) return;
  const { browser, navigate } = scenario; await navigate(); await settingsTab(browser, 'preferences');
  const layout=await browser.evaluate(`(()=>{
    const m=document.getElementById('defaultModelSelect'), t=document.getElementById('defaultThinking'), note=document.querySelector('#preferencesTab .settings-scope-note');
    const a=m.getBoundingClientRect(), b=t.getBoundingClientRect();
    return {sameRow:Math.abs(a.top-b.top)<1,height:a.height,thinkingWidth:b.width,separate:a.right<b.left,title:m.title,name:m.selectedOptions[0].textContent,background:getComputedStyle(note).backgroundColor,noteBelow:note.getBoundingClientRect().top>=a.bottom};
  })()`);
  assert.equal(layout.sameRow,true); assert.equal(layout.height,36); assert.equal(layout.thinkingWidth,160);
  assert.equal(layout.separate,true); assert.equal(layout.title,layout.name);
  assert.equal(layout.background,'rgba(0, 0, 0, 0)'); assert.equal(layout.noteBelow,true);
  assert.deepEqual(browser.issues, []);
});

test('阅读设置三档字号在首页与助手一致', {timeout:30000}, async t => {
  const scenario=await browserScenario(t, {width:1280,height:720});if(!scenario)return;
  const {browser,navigate,fixture}=scenario;
  for(const [size,font] of [['small','14px'],['standard','16px'],['large','18px']]) {
    await t.test(size, async()=>{
      await navigate();
      // Fresh preference state per subcase; only the browser process is reused.
      await browser.evaluate('localStorage.clear();sessionStorage.clear()');
      await navigate();await settingsTab(browser,'reading');
      await browser.evaluate(`const e=document.querySelector('.reading-settings-inline [name=size]');e.value='${size}';e.dispatchEvent(new Event('change'))`);
      await paint(browser);
      assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#messages .bubble')).fontSize"),font);
      await navigate('/');await browser.waitFor("document.querySelector('#chatMessages > .message')");
      assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#chatMessages > .message')).fontSize"),font);
      assert.ok(fixture.state.eventClients.size<=1, '换页不能累积旧事件连接');
    });
  }
  assert.deepEqual(browser.issues, []);
});
