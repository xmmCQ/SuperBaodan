import test from 'node:test';
import assert from 'node:assert/strict';
import { browserScenario } from './helpers/browser-scenario.mjs';

test('首页共用设置：原地弹窗、六页签、配置保存、阅读生效和草稿保护', {timeout:35000}, async t => {
  const scenario=await browserScenario(t);if(!scenario)return;
  const {browser:b,navigate,shot}=scenario;
  await b.addInitScript(`
    const original=fetch;window.requests=[];
    let config={providers:{demo:{name:'测试供应商',baseUrl:'https://example.invalid/v1',api:'openai-completions',models:[{id:'demo',name:'测试模型'}]}}};
    window.fetch=async(...args)=>{const url=new URL(String(args[0]),location.href).pathname;requests.push(url);
      if(url==='/api/models/config') {if(args[1]?.method&&args[1].method!=='GET'){config=JSON.parse(args[1].body);window.savedConfig=config;}return new Response(JSON.stringify(config),{headers:{'Content-Type':'application/json'}});}
      return original(...args);
    };
  `);
  await navigate('/');
  await b.waitFor("document.documentElement.classList.contains('app-ready')&&chatMessages.querySelector('.message.assistant')");
  const before=await b.evaluate("({url:location.href,messages:chatMessages.textContent,nav:performance.getEntriesByType('navigation').length,color:getComputedStyle(sendButton).backgroundColor,font:getComputedStyle(document.body).fontFamily,launches:requests.filter(p=>p==='/api/agent/launch').length})");
  await b.evaluate("chatInput.value='保留首页输入草稿';homeSettingsButton.click()");
  await b.waitFor("document.getElementById('homeSettingsHost')?.shadowRoot.getElementById('settingsDialog')?.open");
  await b.evaluate("window.settingsRoot=homeSettingsHost.shadowRoot;window.setting=id=>settingsRoot.getElementById(id)");
  await b.waitFor("settingsRoot.querySelector('.provider-card')&&!homeSettingsButton.disabled");
  assert.deepEqual(await b.evaluate('(()=>{const r=setting("settingsDialog").getBoundingClientRect();return [r.width,r.height]})()'),[920,680]);
  await shot('home-settings');
  for (const tab of ['accounts','preferences','projectPrompt','skills','reading','custom']) {
    await b.evaluate(`settingsRoot.querySelector('[data-settings-tab=${tab}]').click()`);
    await b.waitFor(`setting('${tab}Tab').classList.contains('active')`);
    if(tab==='preferences') await b.waitFor("setting('defaultModelSelect').options.length>0");
    if(tab==='projectPrompt') await b.waitFor("!settingsRoot.querySelector('.project-prompt-editor').disabled");
    if(tab==='reading') {
      await b.evaluate("const select=settingsRoot.querySelector('[name=size]');select.value='large';select.dispatchEvent(new Event('change'))");
      await b.waitFor("chatMessages.dataset.readingSize==='large'");
    }
    if(tab==='custom') await b.waitFor("setting('providerConfigSelect').options.length>0");
    assert.ok(await b.evaluate(`setting('${tab}Tab').scrollWidth<=setting('${tab}Tab').clientWidth+1`),tab);
  }
  await b.evaluate("setting('providerName').value='修改后的测试供应商';setting('saveModelsConfig').click()");
  await b.waitFor("window.savedConfig?.providers.demo.name==='修改后的测试供应商'");
  assert.equal(await b.evaluate('chatInput.value'),'保留首页输入草稿');
  // Closing or switching away from a dirty project prompt still requires confirmation.
  await b.evaluate("settingsRoot.querySelector('[data-settings-tab=projectPrompt]').click()");
  await b.waitFor("!settingsRoot.querySelector('.project-prompt-editor').disabled");
  await b.evaluate("settingsRoot.querySelector('.project-prompt-editor').value='尚未保存的提示词';setting('closeSettings').click()");
  await b.waitFor("setting('uiDialog').open");
  await b.evaluate("setting('uiDialogCancel').click()"); await b.waitFor("!setting('uiDialog').open");
  assert.equal(await b.evaluate("setting('settingsDialog').open&&settingsRoot.querySelector('.project-prompt-editor').value==='尚未保存的提示词'"),true);
  await b.evaluate("settingsRoot.querySelector('[data-settings-tab=reading]').click()");
  await b.waitFor("setting('uiDialog').open");await b.evaluate("setting('uiDialogConfirm').click()");
  await b.waitFor("setting('readingTab').classList.contains('active')");
  await b.evaluate("setting('settingsDialog').dispatchEvent(new Event('cancel',{cancelable:true}))");
  await b.waitFor("!setting('settingsDialog').open");
  await b.waitFor('document.activeElement===homeSettingsButton');
  const after=await b.evaluate("({url:location.href,messages:chatMessages.textContent,nav:performance.getEntriesByType('navigation').length,color:getComputedStyle(sendButton).backgroundColor,font:getComputedStyle(document.body).fontFamily,launches:requests.filter(p=>p==='/api/agent/launch').length})");
  assert.deepEqual(after,before);
  await b.evaluate('homeSettingsButton.click()');await b.waitFor("setting('settingsDialog').open");
  assert.equal(await b.evaluate("document.querySelectorAll('#homeSettingsHost').length"),1);
  assert.equal(await b.evaluate('chatInput.value'),'保留首页输入草稿');
  assert.deepEqual(b.issues,[]);
});

test('助手普通启动和工作区切换不自动打开设置', {timeout:30000}, async t=>{
  const scenario=await browserScenario(t,{initScript:`const original=fetch;const workspaces=[{id:'test-workspace',name:'测试工作区',root:'TEMP',available:true,isDefault:true},{id:'other-workspace',name:'另一测试工作区',root:'TEMP-OTHER',available:true}];let active=workspaces[0];const reply=d=>new Response(JSON.stringify(d),{headers:{'Content-Type':'application/json'}});window.fetch=async(...args)=>{const url=new URL(String(args[0]),location.href).pathname;if(url==='/api/workspaces')return reply({items:workspaces,activeWorkspaceId:active.id});if(url.endsWith('/activate')&&url.startsWith('/api/workspaces/')){active=workspaces.find(w=>url.includes('/'+w.id+'/'));return reply({ok:true,workspace:active});}const r=await original(...args);if(url==='/api/agent/bootstrap'){const data=await r.json();data.workspace=active;data.workspaces={items:workspaces,activeWorkspaceId:active.id};return reply(data);}return r;};`});if(!scenario)return;
  const {browser,navigate}=scenario;await navigate();
  assert.equal(await browser.evaluate('settingsDialog.open'),false);
  for(const name of ['另一测试工作区','测试工作区']) {
    await browser.evaluate('workspaceSwitcher.click()');await browser.waitFor("document.querySelector('.workspace-switcher-row:not(.active) .workspace-switcher-main')");
    await browser.evaluate("document.querySelector('.workspace-switcher-row:not(.active) .workspace-switcher-main').click()");
    await browser.waitFor(`workspaceSwitcher.querySelector('[data-workspace-label]').textContent==='${name}'&&document.querySelectorAll('#messages>.message').length>=2`);
    assert.equal(await browser.evaluate('settingsDialog.open'),false);
  }
  assert.deepEqual(browser.issues,[]);
});
