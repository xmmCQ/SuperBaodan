import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRuntimeContext } from '../app/services/runtime-context.mjs';
import { createCommands } from '../app/services/commands/index.mjs';
import { LocalAgentStub } from './helpers/local-agent-stub.mjs';
import { createTempProject } from './helpers/temp-project.mjs';
import { captureWorkspace, withWorkspaceSnapshot } from '../app/services/workspace-operations.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function setup(t){
  const temp=await createTempProject('workspace-races-');await temp.ensureDir('A');await temp.ensureDir('B');await temp.ensureDir('sessions');
  const calls=[],agent=new LocalAgentStub(calls);
  const context=await createRuntimeContext({root:temp.root,workspaceDir:temp.resolve('A'),piAgentDir:temp.resolve('agent'),piSessionDir:temp.resolve('sessions'),backupDir:temp.resolve('backups'),todoFile:temp.resolve('todo.md'),vskillFile:temp.resolve('vskills.json'),dailyRecordFile:temp.resolve('records.json'),workspaceFile:temp.resolve('workspaces.json'),agentClient:agent});
  const A=context.activeWorkspace,B=await context.workspaceRegistry.add({name:'B',path:temp.resolve('B')}),sessionPath=temp.resolve('sessions/a.jsonl');
  await fs.writeFile(sessionPath,JSON.stringify({type:'session',id:'session-A',cwd:A.canonicalRoot})+'\n');
  const commands=createCommands(context),releases=[];
  t.after(async()=>{releases.forEach(r=>r());await context.workspaceSwitchQueue.catch(()=>{});await context.shutdown();await temp.cleanup();});
  return {temp,context,agent,A,B,sessionPath,calls,releases,invoke:commands.invoke};
}

test('IPC上传排队期间切换A到B：旧工作区请求被拒绝且不写入文件',async t=>{
  const h=await setup(t);await fs.writeFile(h.temp.resolve('B/same.txt'),'B original');
  const args={workspaceId:h.A.id,name:'same.txt',overwrite:true,content:Buffer.from('incoming')};await h.context.activateWorkspace(h.B.id);
  await assert.rejects(h.invoke('files.upload',args),{statusCode:409});assert.equal(await fs.readFile(h.temp.resolve('B/same.txt'),'utf8'),'B original');await assert.rejects(fs.stat(h.temp.resolve('A/same.txt')),{code:'ENOENT'});
});
test('上传已经进入写入阶段时，工作区切换等待写入完成',async t=>{
  const h=await setup(t),entered=deferred(),release=deferred();h.releases.push(release.resolve);
  const service=h.context.workspaceService,upload=service.upload.bind(service);
  service.upload=async(...args)=>{entered.resolve();await release.promise;assert.equal(h.context.activeWorkspace.id,h.A.id);return upload(...args);};
  const posting=h.invoke('files.upload',{workspaceId:h.A.id,name:'only-A.txt',content:Buffer.from('A contents')});await entered.promise;
  let switched=false;const next=h.context.activateWorkspace(h.B.id).then(()=>switched=true);await new Promise(setImmediate);assert.equal(switched,false);
  release.resolve();assert.equal((await posting).ok,true);await next;assert.equal(await fs.readFile(h.temp.resolve('A/only-A.txt'),'utf8'),'A contents');await assert.rejects(fs.stat(h.temp.resolve('B/only-A.txt')),{code:'ENOENT'});
});
for(const action of ['open','rename','delete'])test(`会话${action}归属扫描期间切换：全过程锁定A，B运行时和最后会话不被污染`,async t=>{
  const h=await setup(t),entered=deferred(),release=deferred();h.releases.push(release.resolve);
  await h.context.workspaceRegistry.setActive(h.A.id,'session-A');h.context.activeWorkspace=h.context.workspaceRegistry.active();
  const scan=h.context.listActiveSessions.bind(h.context);h.context.listActiveSessions=async(...args)=>{entered.resolve();await release.promise;return scan(...args);};
  const pending=h.invoke('sessions.'+(action==='open'?'activate':action),{workspaceId:h.A.id,path:h.sessionPath,name:'renamed'});await entered.promise;
  let switchEntered=false;const validate=h.context.workspaceRegistry.validateRegistered.bind(h.context.workspaceRegistry);h.context.workspaceRegistry.validateRegistered=(...args)=>{switchEntered=true;return validate(...args);};
  const switching=h.context.activateWorkspace(h.B.id);await new Promise(setImmediate);assert.equal(switchEntered,false);release.resolve();assert.equal((await pending).ok,true);await switching;
  assert.ok(h.calls.includes(`A:${action}:${h.sessionPath}`));assert.equal(h.calls.some(c=>c.startsWith(`B:${action}:`)),false);
  const registry=await h.context.workspaceRegistry.list();assert.equal(registry.items.find(w=>w.id===h.A.id).lastSessionId,action==='delete'?null:'session-A');assert.notEqual(registry.items.find(w=>w.id===h.B.id).lastSessionId,'session-A');
});
test('旧IPC请求与A→B→A的旧快照被拒绝，失败不阻塞后续队列',async t=>{
  const h=await setup(t),old=captureWorkspace(h.context,h.A.id);await h.context.activateWorkspace(h.B.id);
  await assert.rejects(h.invoke('sessions.activate',{workspaceId:h.A.id,path:h.sessionPath}),{statusCode:409});await h.context.activateWorkspace(h.A.id);
  await assert.rejects(withWorkspaceSnapshot(h.context,old,h.A.id,()=>assert.fail('stale callback')),{statusCode:409});const current=captureWorkspace(h.context,h.A.id);assert.equal(await withWorkspaceSnapshot(h.context,current,h.A.id,()=> 'ok'),'ok');
});
for(const name of ['agent.bootstrap','agent.new','agent.start','agent.snapshot']){
  test(`${name}被阻塞时切换必须等待，结果和记忆仍属于A`,async t=>{
    const h=await setup(t),entered=deferred(),release=deferred();h.releases.push(release.resolve);
    const invoke=h.agent.invoke.bind(h.agent);h.agent.hooks.set(name,async(args,options)=>{entered.resolve();await release.promise;h.agent.hooks.delete(name);return invoke(name,args,options);});
    const request=h.invoke(name,{workspaceId:h.A.id,messages:'1'});await entered.promise;
    let switching=false;const validate=h.context.workspaceRegistry.validateRegistered.bind(h.context.workspaceRegistry);h.context.workspaceRegistry.validateRegistered=(...args)=>{switching=true;return validate(...args);};
    const next=h.context.activateWorkspace(h.B.id);await new Promise(setImmediate);assert.equal(switching,false);release.resolve();const result=await request;await next;
    if(name==='agent.bootstrap'){assert.equal(result.workspace.id,h.A.id);assert.equal(result.state.sessionId,'fresh-A');assert.equal(result.messages[0].owner,'A');assert.equal(result.workspaces.activeWorkspaceId,h.A.id);}
    if(name==='agent.snapshot')assert.equal(result.owner,'A');
    const registry=await h.context.workspaceRegistry.list();assert.equal(registry.items.find(w=>w.id===h.B.id).lastSessionId,'fresh-B');
    if(['agent.new','agent.bootstrap'].includes(name))assert.equal(registry.items.find(w=>w.id===h.A.id).lastSessionId,name==='agent.new'?'new-A':'fresh-A');
  });
  test(`${name}排在切换之后拒绝旧A请求，包括A→B→A`,async t=>{
    for(const roundTrip of [false,true]){
      const h=await setup(t),gate=deferred();h.releases.push(gate.resolve);h.context.workspaceSwitchQueue=gate.promise;
      const changes=[h.context.activateWorkspace(h.B.id)];if(roundTrip)changes.push(h.context.activateWorkspace(h.A.id));
      const rejected=assert.rejects(h.invoke(name,{workspaceId:h.A.id,messages:'1'}),{statusCode:409});gate.resolve();await Promise.all(changes);await rejected;assert.equal(h.calls.some(c=>c.endsWith(':new')),false);
    }
  });
}
test('初始化和新会话请求排队期间取消：执行前返回499，不启动运行时',async t=>{
  for(const name of ['agent.bootstrap','agent.new','agent.start','agent.snapshot']){
    const h=await setup(t),gate=deferred();h.releases.push(gate.resolve);h.context.workspaceSwitchQueue=gate.promise;h.agent.hooks.set(name,async()=>assert.fail('cancelled operation ran'));
    const controller=new AbortController(),request=assert.rejects(h.invoke(name,{workspaceId:h.A.id,messages:'1'},controller.signal),{statusCode:499});controller.abort();gate.resolve();await request;
  }
});
test('初始化等待扩展弹窗：回复、界面取回和停止命令不排队',async t=>{
  const h=await setup(t),entered=deferred(),reply=deferred();h.releases.push(reply.resolve);const invoke=h.agent.invoke.bind(h.agent);
  h.agent.hooks.set('agent.bootstrap',async(args,options)=>{entered.resolve();await reply.promise;h.agent.hooks.delete('agent.bootstrap');return invoke('agent.bootstrap',args,options);});
  h.agent.hooks.set('agent.uiPayload',async()=>({dialog:true}));h.agent.hooks.set('agent.command',async command=>{if(command.type==='extension_ui_response')reply.resolve();return {ok:true,data:{}};});
  const request=h.invoke('agent.bootstrap',{workspaceId:h.A.id});await entered.promise;
  assert.deepEqual(await h.invoke('agent.uiPayload',{workspaceId:h.A.id,token:'dialog'}),{dialog:true});await h.invoke('agent.command',{type:'abort',workspaceId:h.A.id});await h.invoke('agent.command',{type:'extension_ui_response',id:'dialog',value:'yes'});assert.equal((await request).workspace.id,h.A.id);
});
test('新会话失败保留本轮文件；排队时进入维护或退出则不执行',async t=>{
  const h=await setup(t);h.context.turnFiles.involved.push('keep.txt');h.agent.hooks.set('agent.new',async()=>{throw Error('new failed');});
  await assert.rejects(h.invoke('agent.new',{workspaceId:h.A.id}),/new failed/);assert.deepEqual(h.context.turnFileSnapshot().involved,['keep.txt']);
  for(const name of ['agent.new','agent.bootstrap','agent.start','agent.snapshot'])for(const shuttingDown of [false,true]){
    const gate=deferred();h.releases.push(gate.resolve);h.context.workspaceSwitchQueue=gate.promise;
    const request=assert.rejects(h.invoke(name,{workspaceId:h.A.id,messages:'1'}),{statusCode:shuttingDown?503:409});h.context.shuttingDown=shuttingDown;h.agent.snapshot.maintenance=!shuttingDown;gate.resolve();await request;h.context.shuttingDown=false;h.agent.snapshot.maintenance=false;
  }
});
