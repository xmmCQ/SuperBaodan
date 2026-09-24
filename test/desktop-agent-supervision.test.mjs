import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createTempProject } from './helpers/temp-project.mjs';
import { processPair, until } from './helpers/process-pair.mjs';
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('Windows原生作业：Agent异常退出清理自有工具，但本地进程仍可用',{timeout:40000},async t=>{
  if(process.platform!=='win32')return t.skip('Windows作业对象');
  const f=await processPair(t,{native:true});await f.service.invoke('agent.start');
  const child=new Promise(resolve=>f.service.on('event',({event})=>{if(event.type==='fixture_child')resolve(event.pid);}));
  const request=f.service.invoke('models.catalog',{fixture:'spawn-block'});const rejected=assert.rejects(request,/断开|未知/);
  const pid=await child;assert.ok(alive(pid));f.agent.currentRun.child.kill();
  await rejected;await until(()=>!f.agent.currentRun,15000);await until(()=>!alive(pid),3000);
  assert.ok((await f.service.invoke('tasks.dashboard')).today);
});
for(const mode of ['blocked','startup-local','startup-agent'])test(`Windows监管父进程硬退出：${mode}无业务进程残留`,{timeout:40000},async t=>{
  if(process.platform!=='win32')return t.skip('Windows作业对象');
  const temp=await createTempProject('agent-owner-');let output='';
  const owner=spawn(process.execPath,['test/helpers/agent-owner-process.mjs',mode],{env:{...process.env,SB_TEST_ROOT:temp.root},stdio:['ignore','pipe','pipe','ipc'],serialization:'advanced',windowsHide:true});
  owner.stderr.on('data',data=>output+=data);
  let timer;
  t.after(async()=>{clearTimeout(timer);if(owner.exitCode==null&&owner.signalCode==null)owner.kill();await new Promise(r=>setTimeout(r,1000));await temp.cleanup();});
  const result=await Promise.race([new Promise(resolve=>owner.on('message',resolve)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(output||'守护启动超时')),22000);})]);
  clearTimeout(timer);
  const pids=result.type==='ready'?[result.local,result.agent,result.tool]:[result.pid];
  owner.kill();await until(()=>pids.every(pid=>!alive(pid)),6000);
  assert.ok(pids.every(pid=>!alive(pid)));
});
