// Isolated visual evidence only; never starts the product's backend or reads user data.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSmokeServer } from '../test/helpers/smoke-server.mjs';
import { launchBrowser } from '../test/helpers/browser-harness.mjs';
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('需要绝对路径作为截图输出目录');
await mkdir(output, { recursive: true });
const fixture = await createSmokeServer(process.argv[3] ? { appRoot: process.argv[3] } : {}); let browser;
const measurements = [];
try {
  fixture.state.sessions[0].name = fixture.state.sessions[0].title = '季度方案评审与重点客户需求跟进记录';
  fixture.state.sessions[0].modified = '2026-09-04T08:30:00Z'; fixture.state.sessions[0].messageCount = 24;
  fixture.state.messages.set('seed', [{ role: 'user', content: '请梳理本周计划，并列出需要确认的事项。' }, { role: 'assistant', content: [{ type: 'text', text: '## 本周工作安排\n\n先确认目标与负责人，再逐项推进。以下内容为匿名界面示例。\n\n- 完成方案评审\n- 汇总反馈和后续计划\n\n```js\nconst status = "ready";\n```' }] }]);
  const catalog = await fixture.state.workDocuments.read();
  await fixture.state.workDocuments.save({ ...catalog, documents: [{ id: 'visual-document', name: '项目评审与重点事项跟进材料', categoryId: 'uncategorized', kind: 'url', target: 'https://example.invalid/projects/anonymous-review/materials-and-follow-up' }] });
  browser = await launchBrowser({ width: 1440, height: 900 });
  await browser.setViewport(1440, 900);
  await browser.addInitScript(`
    const nativeFetch=window.fetch;
    window.fetch=(...args)=>{
      const url=String(args[0]); const reply=x=>Promise.resolve(new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}}));
      if(url==='/api/auth/providers') return reply({oauthProviders:[{id:'openai-codex',name:'示例账号',loggedIn:true}],apiKeyProviders:[{id:'openai',name:'示例供应商一',configured:true},{id:'deepseek',name:'示例供应商二',configured:false},{id:'kimi-coding',name:'示例供应商三',configured:false}]});
      if(url==='/api/skills') return reply({skills:['global','project'].map(scope=>({id:'review-'+scope,name:'review',scope,writable:true,description:'整理评审材料和待确认事项',body:'这是隔离样例技能正文。',content:'这是隔离样例技能正文。',filePath:'C:/匿名示例/较长的项目资料目录/'+scope+'/review/SKILL.md',loadState:scope==='global'?'selected':'shadowed',collision:{kind:'duplicate',peers:[{id:'review-other',scope:scope==='global'?'project':'global',filePath:'C:/匿名示例/另一来源/review/SKILL.md'}]}})),diagnostics:[],cliAvailable:false});
      return nativeFetch(...args);
    }; localStorage.setItem('super-baodan.skill-groups.v1',JSON.stringify({global:true,project:true}));
  `);
  async function capture(name) {
    await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const data = await browser.evaluate(`(()=>{const keys=['.app-shell','.calendar-panel','.day-panel','.chat-panel','.task-card-title','.task-meta','.task-edit','.message','#messages .bubble','#chatMessages > .message','.composer','#chatForm','#sessionSidebar','#sessionSidebar .session-item b','.session-meta','#settingsDialog[open]','#defaultModelSelect','#defaultThinking','.wd-editor[open]','.wd-editor input'];const result={width:innerWidth,height:innerHeight,dpr:devicePixelRatio,bodyWidth:document.documentElement.scrollWidth};for(const key of keys){const e=document.querySelector(key);if(!e)continue;const r=e.getBoundingClientRect(),s=getComputedStyle(e);result[key]={x:r.x,y:r.y,width:r.width,height:r.height,font:s.fontSize,color:s.color,background:s.backgroundColor,zoom:s.zoom};}result.smallText=[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&parseFloat(getComputedStyle(e).fontSize)<12).map(e=>({tag:e.tagName,css:e.className,font:getComputedStyle(e).fontSize,text:e.textContent.slice(0,35)}));return result})()`);
    measurements.push({ name, ...data }); await writeFile(path.join(output, name+'.png'), await browser.screenshot());
  }
  const base=`http://127.0.0.1:${fixture.port}`;
  await browser.navigate(base+'/'); await browser.waitFor("document.documentElement.classList.contains('app-ready')");
  await browser.evaluate('todayButton.click()'); await browser.waitFor("document.querySelector('.calendar-day.selected')?.dataset.date==='2026-09-04'");
  await capture('home-empty');
  for(let i=0;i<12;i++) fixture.state.tasks.push({id:'visual-'+i,kind:'daily',text:i===0?'这是需要完整阅读的较长事项标题，窄列中应自然换行':'示例工作事项 '+(i+1),editableText:'示例工作事项',plannedDate:'2026-09-04',dueDate:'2026-09-07',checked:false,headingPath:['工作安排'],sourceLine:i+1});
  await browser.evaluate('refreshButton.click()'); await browser.waitFor("!refreshButton.disabled && document.querySelectorAll('#dayTasks .task-card').length===12");
  await browser.waitFor("!document.querySelector('.toast')");
  for(const [w,h] of [[960,640],[1280,720],[1440,900],[1920,1080],[2560,1440]]){await browser.setViewport(w,h);await capture(`home-${w}x${h}`);}
  await browser.setViewport(1440,900);
  await browser.evaluate('workDocumentsButton.click()'); await browser.waitFor("document.querySelector('.wd-toolbar .wd-primary')?.disabled===false");
  await capture('documents'); await browser.evaluate("document.querySelector('.wd-toolbar .wd-primary').click()");
  await browser.waitFor("!!document.querySelector('.wd-editor[open]')");
  await browser.evaluate("document.querySelector('.wd-editor [aria-label=文档名称]').value='项目评审与跟进材料'; document.querySelector('.wd-editor [aria-label=文件路径或网址]').value='C:/匿名示例/项目资料/较长的文件夹名称/需求清单.docx'");
  await capture('document-editor');
  await browser.evaluate("document.querySelector('.wd-editor .wd-footer button:last-child').previousElementSibling.click()");
  await browser.waitFor('uiDialog.open'); await browser.evaluate('uiDialogConfirm.click()');
  await browser.waitFor("!document.querySelector('.wd-editor[open]')");
  await browser.navigate(base+'/assistant.html'); await browser.waitFor("document.querySelectorAll('#messages > .message').length>=2");
  await capture('assistant');
  await browser.evaluate("document.getElementById('showWorkspace').click()"); await capture('assistant-files');
  await browser.evaluate('settingsButton.click()'); await browser.waitFor('settingsDialog.open');
  for(const tab of ['accounts','preferences','projectPrompt','skills','reading','custom']){
    await browser.evaluate(`document.querySelector('[data-settings-tab=${tab}]').click()`);
    await browser.waitFor(`document.getElementById('${tab}Tab').classList.contains('active')`);
    if(tab==='accounts')await browser.waitFor("document.querySelectorAll('#oauthProviders .provider-card').length>0");
    if(tab==='projectPrompt')await browser.waitFor("!document.querySelector('.project-prompt-reload').disabled");
    if(tab==='skills')await browser.waitFor("document.querySelectorAll('.skill-list-select').length>0");
    await capture('settings-'+tab);
  }
  await writeFile(path.join(output,'measurements.json'), JSON.stringify(measurements,null,2));
  console.log(`Saved ${measurements.length} screenshots and measurements to ${output}`);
} finally { try { await browser?.close(); } finally { await fixture.close(); } }
