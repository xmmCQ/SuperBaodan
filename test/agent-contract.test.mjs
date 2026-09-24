import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { processPair, until } from './helpers/process-pair.mjs';
const entry=path.resolve('test/helpers/contract-agent-process.mjs');
function nextEvent(service,predicate){return new Promise(resolve=>{const listener=message=>{if(predicate(message)){service.off('event',listener);resolve(message.event);}};service.on('event',listener);});}

test('独立Agent：会话、模型偏好、登录取消/输入、技能与提示词保存重载', {timeout:30000},async t=>{
  const f=await processPair(t,{agentEntry:entry});await f.service.invoke('agent.start');
  const boot=await f.service.invoke('agent.bootstrap');assert.ok(boot.state.sessionId);const workspaceId=boot.workspace.id;
  const command=body=>f.service.invoke('agent.command',{...body,workspaceId});
  await command({type:'set_model',provider:'p',modelId:'b',sessionId:boot.state.sessionId});await command({type:'set_thinking_level',level:'high'});
  assert.equal((await command({type:'get_state'})).data.model.id,'b');
  await f.service.invoke('models.saveDisplay',{enabledModels:['p/a','q/c']});await f.service.invoke('models.saveDefaults',{defaultModel:{provider:'q',modelId:'c'},defaultThinkingLevel:'off'});
  assert.equal((await command({type:'get_state'})).data.model.id,'b');assert.equal((await f.service.invoke('models.refresh')).refresh.status,'success');
  const prompt=await f.service.invoke('projectPrompt.read',{workspaceId});const saved=await f.service.invoke('projectPrompt.save',{workspaceId,revision:prompt.revision,content:'# 隔离测试提示词'});assert.equal(saved.applied,true);
  assert.equal((await f.service.invoke('projectPrompt.read',{workspaceId})).content,'# 隔离测试提示词');
  assert.equal((await f.service.invoke('skills.list')).skills[0].collision.kind,'conflict');assert.equal((await f.service.invoke('skills.createCustom',{name:'fixture',workspaceId})).skill.name,'fixture');
  const input=nextEvent(f.service,m=>m.topic==='auth'&&m.event.type==='input');await f.service.invoke('auth.start',{providerId:'q',subscriptionId:'login-one'});
  const request=await input,success=nextEvent(f.service,m=>m.topic==='auth'&&m.event.type==='success');await f.service.invoke('auth.input',{id:'q',token:request.token,value:'fixture-code'});await success;
  const secondInput=nextEvent(f.service,m=>m.topic==='auth'&&m.event.type==='input');await f.service.invoke('auth.start',{providerId:'q',subscriptionId:'login-two'});await secondInput;
  const cancelled=nextEvent(f.service,m=>m.topic==='auth'&&m.event.type==='cancelled');await f.service.invoke('auth.cancel',{subscriptionId:'login-two'});await cancelled;
  const oldPath=boot.state.sessionFile;await f.service.invoke('sessions.rename',{path:oldPath,name:'改名会话',workspaceId});
  assert.ok((await f.service.invoke('sessions.list',{workspaceId})).sessions.some(s=>s.name==='改名会话'));
  const fresh=await f.service.invoke('agent.new',{workspaceId});assert.notEqual(fresh.state.sessionId,boot.state.sessionId);
  await f.service.invoke('sessions.activate',{path:oldPath,workspaceId});assert.equal((await command({type:'get_state'})).data.sessionId,boot.state.sessionId);
  await f.service.invoke('sessions.delete',{path:fresh.state.sessionFile,workspaceId});assert.ok(!(await f.service.invoke('sessions.list')).sessions.some(s=>s.id===fresh.state.sessionId));
});

test('切换两阶段确认、启动期间大UI取回/响应不死锁、失败回滚与忙碌执行点检查', {timeout:30000},async t=>{
  const f=await processPair(t,{agentEntry:entry});await f.service.invoke('agent.start');const first=await f.service.invoke('agent.bootstrap');
  const targetPath=await f.temp.ensureDir('needs-ui');const added=await f.service.invoke('workspaces.add',{name:'交互工作区',path:targetPath});
  const ui=nextEvent(f.service,m=>m.event.type==='extension_ui_payload');const switching=f.service.invoke('workspaces.activate',{id:added.workspace.id});
  const token=await ui;assert.equal((await f.service.invoke('workspaces.list')).activeWorkspaceId,first.workspace.id);
  assert.ok((await f.service.invoke('tasks.dashboard')).today); // Local commands do not wait for interaction.
  const payload=await f.service.invoke('agent.uiPayload',{token:token.token,workspaceId:token.workspaceId});assert.equal(payload.options.length,40000);
  await f.service.invoke('agent.command',{type:'extension_ui_response',id:payload.id,value:payload.options[0]});
  const second=await switching;assert.equal((await f.service.invoke('workspaces.list')).activeWorkspaceId,added.workspace.id);
  const failedPath=await f.temp.ensureDir('fail-target'),bad=await f.service.invoke('workspaces.add',{name:'失败工作区',path:failedPath});
  await assert.rejects(f.service.invoke('workspaces.activate',{id:bad.workspace.id}),/startup failed/);
  assert.equal((await f.service.invoke('workspaces.list')).activeWorkspaceId,second.workspace.id);
  assert.equal((await f.service.invoke('agent.bootstrap')).state.sessionId,second.state.sessionId);
  await f.service.invoke('agent.command',{type:'prompt',message:'busy',fixture:'busy',requestId:randomUUID()});
  await assert.rejects(f.service.invoke('workspaces.activate',{id:first.workspace.id}),/任务完成/);
  assert.equal((await f.service.invoke('system.status')).assistantRunning,true);await f.service.invoke('agent.command',{type:'abort'});
  await f.service.invoke('workspaces.activate',{id:first.workspace.id});assert.equal((await f.service.invoke('agent.bootstrap')).state.sessionId,first.state.sessionId);
  await assert.rejects(f.service.invoke('agent.command',{type:'extension_ui_response',id:payload.id,value:'old'}),/过期/);
});

test('提示已落盘但Agent响应丢失：回执unknown，不自动重复执行', {timeout:20000},async t=>{
  const f=await processPair(t,{agentEntry:entry});await f.service.invoke('agent.start');const boot=await f.service.invoke('agent.bootstrap');const requestId=randomUUID();
  await assert.rejects(f.service.invoke('agent.command',{type:'prompt',message:'唯一提交',fixture:'crash-after-write',requestId}),/断开|未知/);await until(()=>!f.agent.currentRun);
  assert.equal((await f.service.invoke('agent.receipt',{requestId})).status,'unknown');
  const before=await readFile(boot.state.sessionFile,'utf8');assert.equal(before.split('唯一提交').length-1,1);
  await f.service.invoke('agent.start',{retry:true});assert.equal((await f.service.invoke('agent.receipt',{requestId})).status,'unknown');assert.equal(await readFile(boot.state.sessionFile,'utf8'),before);
});
