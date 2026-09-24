import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { createTempProject } from './helpers/temp-project.mjs';
import { listenOnSafePort } from './helpers/listen.mjs';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('等待桌面状态超时')),ms))]);}finally{clearTimeout(timer);}}
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('一次桌面冒烟：首次切日、助手就绪、工作区切换及托盘退出链', {timeout:90000},async t=>{
  const root=path.resolve('.'),electron=path.join(root,'node_modules/electron/dist/electron.exe');
  if(process.platform!=='win32'||!existsSync(electron))return t.skip('需要Windows Electron');
  const temp=await createTempProject('sb-agent-desktop-');let child,socket;
  t.after(async()=>{socket?.close();if(child&&child.exitCode==null&&child.signalCode==null){child.kill();await wait(6500);}await temp.cleanup();});
  const data='SuperBaodan/desktop-dev/runtime';await temp.write(`${data}/work-todo.md`,'# 工作待办\n- [ ] 隔离验收事项 📅 2026-09-04\n');await temp.writeJson(`${data}/pi-agent/settings.json`,{packages:[]});
  const target=await temp.ensureDir('another-workspace');
  const sdk=process.env.SUPER_BAODAN_PI_PACKAGE || path.join(process.env.APPDATA,'npm/node_modules/@earendil-works/pi-coding-agent');
  const env={...process.env,LOCALAPPDATA:temp.root,APPDATA:await temp.ensureDir('appdata'),HOME:temp.root,USERPROFILE:temp.root,PI_OFFLINE:'1',SUPER_BAODAN_PI_PACKAGE:sdk};
  for(const key of Object.keys(env))if(/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key))delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;delete env.SUPER_BAODAN_DESKTOP_USE_EXISTING_CONFIG;
  const probe=net.createServer(),port=await listenOnSafePort(probe);await new Promise(r=>probe.close(r));
  child=spawn(electron,[root,`--remote-debugging-port=${port}`],{cwd:root,env,stdio:'ignore',windowsHide:true});const exited=new Promise(resolve=>child.once('exit',resolve));
  let page;for(let n=0;n<600&&!page;n++){try{page=(await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(250)})).json()).find(p=>p.type==='page'&&p.url==='app://workbench/');}catch{}if(!page)await wait(25);}
  assert.ok(page,'首页必须使用app://');socket=new WebSocket(page.webSocketDebuggerUrl);await bounded(new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;}),5000);
  let sequence=0;const pending=new Map();socket.onmessage=({data})=>{const value=JSON.parse(data);pending.get(value.id)?.(value);pending.delete(value.id);};
  const evaluate=async expression=>{const id=++sequence,promise=new Promise(resolve=>pending.set(id,resolve));socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));const reply=await bounded(promise,20000);assert.ok(!reply.error&&!reply.result?.exceptionDetails,JSON.stringify(reply));return reply.result.result.value;};
  const until=async expression=>{for(let n=0;n<500;n++){if(await evaluate(expression))return;await wait(40);}assert.fail('等待超时：'+expression);};
  await until("document.documentElement?.classList.contains('app-ready')&&document.getElementById('calendarGrid')?.children.length===42&&document.getElementById('newTaskButton')?.disabled===false");
  const firstDateMs=await evaluate(`new Promise((resolve,reject)=>{const button=[...calendarGrid.querySelectorAll('.calendar-day:not(.selected):not(.outside)')][0],old=selectedDateTitle.textContent,start=performance.now();const timer=setTimeout(()=>{observer.disconnect();reject(Error('首次切日超时'));},15000);const observer=new MutationObserver(()=>{if(!newTaskButton.disabled&&selectedDateTitle.textContent!==old){clearTimeout(timer);observer.disconnect();resolve(performance.now()-start);}});observer.observe(document.querySelector('.day-panel'),{attributes:true,subtree:true,childList:true});button.click();})`);
  t.diagnostic(`首次切日：${firstDateMs.toFixed(1)}ms（隔离数据，单次记录，不设硬门槛）`);
  await until("window.workbench.invoke('smoke-status','system.status',{}).then(r=>r.ok&&r.value.assistantRunning&&r.value.assistantState==='running')");
  const added=await evaluate(`window.workbench.invoke('smoke-add','workspaces.add',{name:'隔离工作区',path:${JSON.stringify(target)}})`);assert.equal(added.ok,true);
  await evaluate('workspaceSwitcher.click()');await until("document.querySelector('.workspace-switcher-row:not(.active) .workspace-switcher-main')");
  await evaluate("document.querySelector('.workspace-switcher-row:not(.active) .workspace-switcher-main').click()");await until("workspaceSwitcher.textContent.includes('隔离工作区')");
  const status=await evaluate("window.workbench.invoke('smoke-after-switch','system.status',{}).then(r=>r.value)");assert.equal(status.workspace.id,added.value.workspace.id);
  const processes=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process | Where-Object {$_.ParentProcessId -eq ${child.pid}} | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`],{encoding:'utf8',maxBuffer:4*1024*1024}));
  const business=[processes].flat().filter(p=>/[\\/]app[\\/](?:services|agent)[\\/]main\.mjs/.test(p.CommandLine || ''));assert.equal(business.length,2,'两个业务进程必须直属Electron');
  // The native tray menu and this controlled entry call the same requestExit.
  await evaluate('window.workbench.requestExit();true');assert.equal(await bounded(exited,16000),0);
  assert.ok(business.every(p=>!alive(p.ProcessId)),'退出后两个业务进程均已回收');
});
