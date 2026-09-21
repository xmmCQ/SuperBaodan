// Real Electron UI checks with disposable data. DPI flags emulate device scaling,
// not Windows system settings and not CSS/application zoom.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempProject } from '../test/helpers/temp-project.mjs';
import { listenOnSafePort } from '../test/helpers/listen.mjs';
import { localDateString } from '../app/services/domain/tasks.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)), electron=path.join(root,'node_modules/electron/dist/electron.exe');
const output=process.argv[2];
if(process.platform!=='win32'||!existsSync(electron)||!output||!path.isAbsolute(output))throw new Error('需要Windows Electron及绝对输出目录');
await mkdir(output,{recursive:true});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('桌面检查超时')),ms)})]);}finally{clearTimeout(timer);}}
const results=[];
for(const scale of [null,1.25,1.5]){
 const temp=await createTempProject('sb-ui-desktop-');let child,socket,exited;
 const label=scale?`dpi-${scale}`:'native-minimum';
 try{
  await temp.writeJson('SuperBaodan/desktop-dev/window-state.json',{bounds:{x:40,y:40,width:scale?1280:960,height:scale?720:640},maximized:false});
  await temp.write('SuperBaodan/desktop-dev/runtime/work-todo.md','# 工作待办\n'+Array.from({length:12},(_,i)=>`- [ ] 匿名桌面验收事项${i+1}：检查实际文字和操作区域 📅 ${localDateString()} <!-- baodan:kind=daily -->`).join('\n')+'\n');
  const env={};
  const allowed=/^(SystemRoot|WINDIR|SystemDrive|COMSPEC|Path|PATHEXT|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i;
  for(const [key,value] of Object.entries(process.env))if(allowed.test(key))env[key]=value;
  Object.assign(env,{LOCALAPPDATA:temp.root,APPDATA:await temp.ensureDir('appdata'),USERPROFILE:temp.root,HOME:temp.root,TEMP:temp.root,TMP:temp.root,SUPER_BAODAN_PI_PACKAGE:path.join(process.env.APPDATA,'npm/node_modules/@earendil-works/pi-coding-agent')});
  const probe=net.createServer(),port=await listenOnSafePort(probe);await new Promise(r=>probe.close(r));
  child=spawn(electron,['.',`--remote-debugging-port=${port}`,...(scale?[`--force-device-scale-factor=${scale}`]:[])],{cwd:root,env,stdio:'ignore',windowsHide:true});
  exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve)});
  let page;
  for(let i=0;i<150&&!page;i++){try{page=(await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(500)})).json()).find(p=>p.type==='page'&&p.url==='app://workbench/');}catch{}if(!page)await wait(100);}
  assert.ok(page,'应加载app://首页');
  socket=new WebSocket(page.webSocketDebuggerUrl);await bounded(new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject}),5000);
  let id=0;const pending=new Map();
  socket.onmessage=({data})=>{const m=JSON.parse(data);pending.get(m.id)?.(m);pending.delete(m.id);};
  async function command(method,params={}){const key=++id;const response=new Promise(resolve=>pending.set(key,resolve));socket.send(JSON.stringify({id:key,method,params}));const m=await bounded(response,12000);if(m.error)throw new Error(JSON.stringify(m.error));return m.result;}
  async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
  async function until(expression){for(let i=0;i<150;i++){if(await evaluate(expression))return;await wait(100);}throw new Error(label+' 页面状态未就绪：'+expression+' '+JSON.stringify(await evaluate("({ready:document.readyState,appReady:document.documentElement?.className,rows:document.querySelectorAll('#dayTasks .task-card').length,title:document.title,month:document.getElementById('monthTitle')?.textContent,notices:[...document.querySelectorAll('.toast')].map(e=>e.textContent)})")));}
  async function click(selector){const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);assert.ok(p.x>=0&&p.y>=0);await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});}
  async function shot(name){await evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');const r=await command('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,`${label}-${name}.png`),Buffer.from(r.data,'base64'));}
  await command('Page.bringToFront');
  await until("document.readyState==='complete' && document.documentElement?.classList.contains('app-ready') && document.querySelectorAll('#dayTasks .task-card').length===12");
  const geometry=await evaluate("(()=>{const shell=document.querySelector('.app-shell'),input=chatForm.getBoundingClientRect();return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,viewportScale:visualViewport.scale,zoom:getComputedStyle(shell).zoom,overflow:document.documentElement.scrollWidth>innerWidth,taskFont:getComputedStyle(document.querySelector('.task-card-title')).fontSize,metaFont:getComputedStyle(document.querySelector('.task-meta')).fontSize,inputVisible:input.bottom<=innerHeight&&input.top>=0,monthTitle:monthTitle.textContent,taskMeta:document.querySelector('.task-meta').textContent.trim(),panelsFit:[...document.querySelectorAll('.calendar-panel,.day-panel,.chat-panel')].every(e=>e.scrollWidth<=e.clientWidth+1&&e.scrollHeight<=e.clientHeight+1)}})()");
  assert.equal(geometry.zoom,'1');assert.equal(geometry.viewportScale,1);assert.equal(geometry.overflow,false);assert.equal(geometry.taskFont,'14px');assert.equal(geometry.metaFont,'12px');assert.equal(geometry.inputVisible,true);assert.equal(geometry.panelsFit,true,JSON.stringify(geometry));
  await click('#newTaskButton');await until("!taskModal.classList.contains('hidden')");await shot('task-form');await click('#cancelTaskButton');
  await until("taskModal.classList.contains('hidden') && document.querySelectorAll('#dayTasks .task-card').length===12");await shot('home');
  await click('#workDocumentsButton');await until("document.querySelector('.wd-toolbar .wd-primary')?.disabled===false");await click('.wd-toolbar .wd-primary');await until("!!document.querySelector('.wd-editor[open]')");await shot('document-editor');
  assert.equal(await evaluate("document.querySelector('.wd-path-row input').getBoundingClientRect().height"),40);
  results.push({label,mode:scale?'Electron device-scale-factor simulation':'native Windows display scale',...geometry,coordinateClicks:true});
  await evaluate('window.workbench.requestExit(); true');assert.equal(await bounded(exited,18000),0);
 }finally{
  socket?.close();
  if(child&&child.exitCode==null&&child.signalCode==null){child.kill();try{await bounded(exited,2500)}catch{}await wait(5500);}
  await temp.cleanup();
 }
}
await writeFile(path.join(output,'measurements.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
