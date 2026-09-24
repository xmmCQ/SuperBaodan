import test from 'node:test';
import assert from 'node:assert/strict';
import { browserScenario, paint } from './helpers/browser-scenario.mjs';

test('@与普通文件搜索：迟到结果不能覆盖新查询或清空后的界面', {timeout:25000}, async t=>{
  const scenario=await browserScenario(t,{initScript:`const original=fetch;window.searches=[];window.fetch=(...args)=>{const u=new URL(String(args[0]),location.href);if(u.pathname==='/api/workspace/search')return new Promise(resolve=>{const item={q:u.searchParams.get('q'),aborted:false,done:false,release(){this.done=true;resolve(new Response(JSON.stringify({results:[{path:this.q+'.txt',name:this.q+'.txt',previewable:true}]}),{headers:{'Content-Type':'application/json'}}));}};args[1]?.signal?.addEventListener('abort',()=>item.aborted=true);searches.push(item);});return original(...args);};`});if(!scenario)return;
  const {browser:b,navigate}=scenario;await navigate();
  await b.evaluate("promptInput.value='@old';promptInput.setSelectionRange(4,4);promptInput.dispatchEvent(new Event('input'))");await b.waitFor('searches.length===1');
  await b.evaluate("promptInput.value='@new';promptInput.setSelectionRange(4,4);promptInput.dispatchEvent(new Event('input'))");await b.waitFor('searches.length===2');
  assert.equal(await b.evaluate('searches[0].aborted'),true);
  await b.evaluate('searches[1].release()');await b.waitFor("atFileMenu.textContent.includes('new.txt')&&!atFileMenu.classList.contains('hidden')");
  await b.evaluate("promptInput.value='';promptInput.dispatchEvent(new Event('input'));searches[0].release()");await paint(b);assert.equal(await b.evaluate("atFileMenu.classList.contains('hidden')"),true);
  await b.evaluate("showWorkspace.click();workspaceSearch.value='first';workspaceSearch.dispatchEvent(new Event('input'))");await b.waitFor('searches.length===3');
  await b.evaluate("workspaceSearch.value='second';workspaceSearch.dispatchEvent(new Event('input'))");await b.waitFor('searches.length===4');
  assert.equal(await b.evaluate('searches[2].aborted'),true);
  await b.evaluate('searches[3].release()');await b.waitFor("workspaceSearchResults.textContent.includes('second.txt')");
  await b.evaluate('searches[2].release()');await paint(b);assert.equal(await b.evaluate('workspaceSearchResults.textContent'),'second.txt');
  assert.deepEqual(b.issues,[]);
});

test('同月切日期保留42个按钮，仅选中状态变化；记录数据变化才重建', {timeout:25000}, async t=>{
  const scenario=await browserScenario(t,{initScript:`const D=Date;window.Date=class extends D{constructor(...args){super(...(args.length?args:['2026-09-04T12:00:00']));}};`});if(!scenario)return;const {browser:b,navigate,fixture}=scenario;await navigate('/');
  await b.waitFor("calendarGrid.children.length===42&&!newTaskButton.disabled");
  await b.evaluate("window.days=[...calendarGrid.children];window.addedDays=0;new MutationObserver(items=>{for(const item of items)addedDays+=item.addedNodes.length}).observe(calendarGrid,{childList:true});calendarGrid.querySelector('[data-date=\"2026-09-05\"]').click()");
  await b.waitFor("selectedDateTitle.textContent.includes('9月5日')&&!newTaskButton.disabled");
  assert.equal(await b.evaluate('days.every((day,i)=>calendarGrid.children[i]===day)&&addedDays===0'),true);
  assert.equal(await b.evaluate("calendarGrid.querySelector('.selected').dataset.date"),'2026-09-05');
  fixture.state.dailyRecords.push({id:'calendar-record',date:'2026-09-05',title:'新记录',type:'work',time:'',content:'内容',createdAt:'2026-09-05T00:00:00Z',updatedAt:'2026-09-05T00:00:00Z'});
  await b.evaluate('refreshButton.click()');await b.waitFor("calendarGrid.querySelector('[data-date=\"2026-09-05\"] .record-calendar-mark')&&!refreshButton.disabled");
  assert.ok(await b.evaluate('addedDays>=42'));assert.deepEqual(b.issues,[]);
});

test('流式回复稳定段落/思考/工具节点；纯文本不重排执行过程，保留工具滚动', {timeout:30000}, async t=>{
  const scenario=await browserScenario(t,{initScript:`let factory;Object.defineProperty(window,'markdownit',{configurable:true,get:()=>factory,set:value=>{factory=(...args)=>{const engine=value(...args),render=engine.render.bind(engine);engine.render=(text,...rest)=>{(window.markdownSizes ||= []).push(text.length);return render(text,...rest);};return engine;};}});`});if(!scenario)return;
  const {browser:b,navigate,fixture}=scenario;await navigate();await b.waitFor("document.querySelectorAll('#messages > .message').length>=2");
  const emit=event=>{for(const client of fixture.state.eventClients)client.write('data: '+JSON.stringify(event)+'\n\n');};
  const delta=data=>emit({type:'message_update',assistantMessageEvent:data});
  emit({type:'message_end',message:{role:'user',content:'流式节点测试',timestamp:100}});emit({type:'agent_start'});emit({type:'message_start',message:{role:'assistant',content:[],timestamp:101}});
  delta({type:'thinking_delta',delta:'思考文本'});delta({type:'toolcall_start',id:'read-1',toolName:'read'});delta({type:'toolcall_delta',id:'read-1',delta:'参数行\n'.repeat(120)});
  const prefix='稳定段落内容'.repeat(700);let text=prefix+'\n\n尾部';delta({type:'text_delta',delta:text});
  await b.waitFor("messages.lastElementChild.querySelector('.thinking')&&messages.lastElementChild.querySelector('.tool-card')&&messages.lastElementChild.textContent.includes('尾部')");
  await b.evaluate(`window.liveNode=messages.lastElementChild;window.think=liveNode.querySelector('.thinking');window.tool=liveNode.querySelector('.tool-card');window.firstParagraph=liveNode.querySelector('.markdown-body p');window.execDrawer=liveNode.querySelector('.execution-process');execDrawer.querySelector('summary').click();think.open=true;tool.open=true;window.toolBody=tool.querySelector('.tool-result');toolBody.scrollTop=50;window.toolTop=toolBody.scrollTop;window.moves=0;new MutationObserver(items=>moves+=items.filter(i=>i.type==='childList').length).observe(execDrawer.querySelector('.execution-steps'),{childList:true});window.markdownSizes=[];window.fullScans=0;const query=messages.querySelectorAll.bind(messages);messages.querySelectorAll=selector=>{if(selector===':scope > .message')fullScans++;return query(selector);};`);
  for(let i=0;i<8;i++){text+='增量文字';delta({type:'text_delta',delta:'增量文字'});await paint(b);}
  assert.equal(await b.evaluate('liveNode.querySelector(".thinking")===think&&liveNode.querySelector(".tool-card")===tool&&liveNode.querySelector(".markdown-body p")===firstParagraph&&think.open&&tool.open'),true);
  assert.equal(await b.evaluate('moves'),0);assert.equal(await b.evaluate('fullScans'),0);assert.equal(await b.evaluate('markdownSizes.length'),0);
  assert.ok(await b.evaluate('toolTop>0'));
  delta({type:'toolcall_delta',id:'read-1',delta:'新增参数\n'});await paint(b);
  assert.equal(await b.evaluate('tool.querySelector(".tool-result")===toolBody&&toolBody.scrollTop===toolTop'),true);
  assert.equal(await b.evaluate('markdownSizes.length'),0);
  delta({type:'thinking_delta',delta:'追加思考'});delta({type:'toolcall_start',id:'read-2',toolName:'read'});await paint(b);
  assert.equal(await b.evaluate("liveNode.querySelector('.thinking')===think&&think.textContent.includes('追加思考')&&liveNode.querySelector('.tool-card')===tool&&liveNode.querySelectorAll('.tool-card').length===2&&tool.open&&toolBody.scrollTop===toolTop"),true);
  const opening='\n\n```js\nconst a = 1;\n';text+=opening;delta({type:'text_delta',delta:opening});await paint(b);
  await b.evaluate("window.codeNode=liveNode.querySelector('pre code');window.copyButton=liveNode.querySelector('[data-copy-code]');markdownSizes=[]");
  const codeDelta='const b = 2;\n';text+=codeDelta;delta({type:'text_delta',delta:codeDelta});await paint(b);
  assert.equal(await b.evaluate("liveNode.querySelector('pre code')===codeNode&&liveNode.querySelector('[data-copy-code]')===copyButton&&codeNode.textContent.includes('const b = 2')"),true);assert.equal(await b.evaluate('markdownSizes.length'),0);
  emit({type:'message_end',message:{role:'assistant',timestamp:101,stopReason:'stop',content:[{type:'text',text:text+'```\n\n**完整结束**'}]}});
  await b.waitFor("messages.lastElementChild.querySelector('strong')?.textContent==='完整结束'");assert.deepEqual(b.issues,[]);
});
