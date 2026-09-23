import test from 'node:test';
import assert from 'node:assert/strict';
import { browserScenario, paint } from './helpers/browser-scenario.mjs';
async function click(b,selector){await b.waitFor(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).visibility==='visible'`);const pt=await b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(x,y)),target:document.elementFromPoint(x,y)?.outerHTML.slice(0,240),style:[getComputedStyle(e).visibility,getComputedStyle(e).pointerEvents,e.disabled,e.closest('[inert]')?.className,e.parentElement.getBoundingClientRect().width]}})()`);assert.equal(pt.hit,true,selector+'被遮挡 '+JSON.stringify(pt));await b.dragPointer({x:pt.x,y:pt.y},{x:pt.x,y:pt.y});}
for(const page of ['home','assistant'])test(`${page}：上下分区、模型菜单真实点击与简短名称、思考等级`,{timeout:30000},async t=>{
  const scenario=await browserScenario(t,{width:1280,height:720,
    configure:({state})=>{state.modelCatalog={models:[{provider:'openai-codex',id:'astra',name:'GPT6-ASTRA',reasoning:true},{provider:'openai-codex',id:'second',name:'第二模型',reasoning:true}],defaultModel:{provider:'openai-codex',modelId:'astra'},defaultThinkingLevel:'medium',enabledModels:[]};},
    initScript:`const original=fetch;window.changes=[];window.fetch=async(...args)=>{const response=await original(...args);if(response.ok&&new URL(String(args[0]),location.href).pathname==='/api/agent/command')changes.push(JSON.parse(args[1].body));return response;};`
  });if(!scenario)return;
  const {fixture,browser:b,navigate,shot}=scenario;await navigate(page==='assistant'?'/assistant.html':'/');
  await b.waitFor("document.getElementById('modelPickerButton')?.textContent==='GPT6-ASTRA'");if(page==='home')await b.waitFor("document.documentElement.classList.contains('app-ready')");await paint(b);
  assert.ok(await b.evaluate(`(()=>{const input=document.getElementById('${page==='home'?'chatInput':'promptInput'}').getBoundingClientRect(),tools=document.querySelector('.composer-controls').getBoundingClientRect(),send=sendButton.getBoundingClientRect(),box=document.querySelector('${page==='home'?'.chat-composer':'.composer'}').getBoundingClientRect();return input.bottom<=tools.top&&send.bottom<box.bottom&&send.left>box.left&&send.right<box.right&&send.top>box.top&&getComputedStyle(document.querySelector('${page==='home'?'.chat-composer':'.composer'}')).borderRadius==='20px'&&send.width===40&&send.height===40&&tools.right<=box.right&&document.documentElement.scrollWidth<=innerWidth})()`));
  await click(b,'#modelPickerButton');await b.waitFor("modelPickerPanel.matches(':popover-open')");
  assert.ok(await b.evaluate('modelPickerPanel.getBoundingClientRect().bottom<modelPickerButton.getBoundingClientRect().top'));
  await shot(page+'-model-menu');
  const originalWidth=await b.evaluate('modelPickerButton.getBoundingClientRect().width');
  await click(b,'.model-option:not(.active)');await b.waitFor("modelPickerButton.textContent==='第二模型'&&!modelPickerPanel.matches(':popover-open')");
  assert.equal(await b.evaluate("changes.find(c=>c.type==='set_model').modelId"),'second');
  assert.equal(fixture.state.sessionSettings.get(fixture.state.activeSessionId).model.id,'second');
  const shortWidth=await b.evaluate('modelPickerButton.getBoundingClientRect().width');
  assert.ok(shortWidth<originalWidth, '短模型名应自动收缩');
  const longWidth=await b.evaluate("(()=>{const previous=modelPickerButton.textContent;modelPickerButton.textContent='很长的模型名称'.repeat(12);const width=modelPickerButton.getBoundingClientRect().width;modelPickerButton.textContent=previous;return width})()");
  assert.ok(longWidth>shortWidth&&longWidth<=280, '长模型名展开但不挤出工具行');
  assert.equal(fixture.state.operations.includes('agent:prompt'),false);
  const mediumWidth=await b.evaluate('thinkingSelect.getBoundingClientRect().width');
  await b.evaluate("thinkingSelect.value='high';thinkingSelect.dispatchEvent(new Event('change'))");await b.waitFor("changes.some(c=>c.type==='set_thinking_level'&&c.level==='high')&&thinkingSelect.value==='high'");
  assert.equal(fixture.state.sessionSettings.get(fixture.state.activeSessionId).thinkingLevel,'high');
  const highWidth=await b.evaluate('thinkingSelect.getBoundingClientRect().width');
  assert.ok(highWidth<mediumWidth, '思考等级应按选中文字收缩');
  const widths=await b.evaluate("(()=>{thinkingSelect.value='off';const short=thinkingSelect.getBoundingClientRect().width;thinkingSelect.value='medium';const long=thinkingSelect.getBoundingClientRect().width;thinkingSelect.value='high';return [short,long,thinkingSelect.getBoundingClientRect().height]})()");
  assert.ok(widths[0]<highWidth&&widths[1]>highWidth);assert.equal(widths[2],36);
  await click(b,'#modelPickerButton');await b.waitFor("modelPickerPanel.matches(':popover-open')");
  await b.evaluate("modelFilter.value='ASTRA';modelFilter.dispatchEvent(new Event('input'))");assert.equal(await b.evaluate('modelPickerList.querySelectorAll(".model-option").length'),1);
  await b.evaluate("modelFilter.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");await b.waitFor("!modelPickerPanel.matches(':popover-open')");assert.equal(await b.evaluate('document.activeElement===modelPickerButton'),true);
  await click(b,'#modelPickerButton');await b.waitFor("modelPickerPanel.matches(':popover-open')");
  assert.equal(await b.evaluate("(()=>{const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});modelFilter.dispatchEvent(e);return e.defaultPrevented})()"),true);
  await b.waitFor("modelPickerButton.textContent==='GPT6-ASTRA'&&!modelPickerPanel.matches(':popover-open')");
  assert.equal(fixture.state.operations.includes('agent:prompt'),false);
  await paint(b);await shot(page+'-layout');
  if(page==='home') {
    await b.evaluate("chatInput.value='隔离发送检查';chatForm.requestSubmit()");
    await b.waitFor("chatMessages.textContent.includes('冒烟回复')");
    assert.equal(fixture.state.operations.includes('agent:prompt'),true);
  }
  assert.deepEqual(b.issues,[]);
});

test('输入区工具栏、目录定位、压缩及附件发送停止', {timeout:30000}, async t=>{
  const scenario=await browserScenario(t,{width:1280,height:720,initScript:`const original=fetch;window.commands=[];window.fetch=(...args)=>{if(String(args[0])==='/api/agent/command'){const cmd=JSON.parse(args[1].body);commands.push(cmd);if(cmd.type==='prompt')return new Promise(resolve=>window.releasePrompt=()=>resolve(new Response(JSON.stringify({ok:true,data:{}}),{headers:{'Content-Type':'application/json'}})));}return original(...args);};`});if(!scenario)return;
  const {browser,fixture,navigate,shot}=scenario;await navigate();
  for(const [width,height] of [[1280,720],[1440,900]]) {
    await browser.setViewport(width,height);await paint(browser);
    assert.ok(await browser.evaluate(`(()=>{const bar=document.querySelector('.toolbar'),r=bar.getBoundingClientRect();return [directoryButton,compactButton,settingsButton,showWorkspace].every(b=>{const q=b.getBoundingClientRect();return b.parentElement===bar&&q.top>=r.top&&q.bottom<=r.bottom&&q.right<=r.right&&q.width===36})&&bar.scrollWidth<=bar.clientWidth})()`));
  }
  await shot('assistant-toolbar');
  await browser.evaluate('directoryButton.click()');await browser.waitFor("directoryButton.getAttribute('aria-expanded')==='true'");
  assert.ok(await browser.evaluate("(()=>{const r=conversationDirectory.getBoundingClientRect(),b=directoryButton.getBoundingClientRect();return r.top>=b.bottom&&r.left>=0&&r.right<=innerWidth})()"));
  await browser.evaluate("conversationDirectory.querySelector('[data-close]').click()");
  assert.equal(await browser.evaluate('document.activeElement===directoryButton'),true);
  await browser.evaluate('compactButton.click()');await browser.waitFor("commands.some(c=>c.type==='compact')&&!compactButton.disabled");
  await browser.evaluate(`(()=>{const dt=new DataTransfer(),bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));dt.items.add(new File([bytes],'sample.png',{type:'image/png'}));imageInput.files=dt.files;imageInput.dispatchEvent(new Event('change'));})()`);
  await browser.waitFor("attachments.querySelector('.attachment-chip')");
  await browser.evaluate("promptInput.value='隔离测试';sendButton.click()");await browser.waitFor("window.releasePrompt&&!stopButton.classList.contains('hidden')");
  assert.equal(await browser.evaluate("commands.find(c=>c.type==='prompt').images.length"),1);
  assert.ok(await browser.evaluate("(()=>{const c=document.querySelector('.composer').getBoundingClientRect(),s=stopButton.getBoundingClientRect();return s.left>c.left&&s.right<c.right&&s.top>c.top&&s.bottom<c.bottom})()"));
  await browser.evaluate('stopButton.click();releasePrompt()');await browser.waitFor("commands.some(c=>c.type==='abort')");
  for(const client of fixture.state.eventClients)client.write('data: '+JSON.stringify({type:'agent_settled'})+'\n\n');
  await browser.waitFor("stopButton.classList.contains('hidden')");
  assert.deepEqual(browser.issues,[]);
});
