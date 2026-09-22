import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dispatchSdkCommand } from '../app/services/domain/pi-sdk-commands.mjs';
import { PiSdkRuntime } from '../app/services/domain/pi-sdk.mjs';
import { findSdkEntry } from '../app/services/domain/pi-sdk-factory.mjs';
import { createTempProject } from './helpers/temp-project.mjs';
import { createAgentClient } from '../app/renderer/core/agent-client.js';
import { createModelsController } from '../app/renderer/assistant/models-controller.js';

const model = { provider: 'fixture', id: 'first' };
test('模型切换必须匹配对话ID，并显式禁止改写默认模型', async () => {
  const calls=[];
  const session={sessionId:'A',modelRuntime:{getAvailableSnapshot:()=>[model]},setModel:async(...args)=>calls.push(args)};
  for(const sessionId of [undefined,'B']) await assert.rejects(dispatchSdkCommand({},session,{type:'set_model',provider:model.provider,modelId:model.id,sessionId}),e=>e.statusCode===409);
  assert.equal(calls.length,0);
  await dispatchSdkCommand({},session,{type:'set_model',provider:model.provider,modelId:model.id,sessionId:'A'});
  assert.deepEqual(calls,[[model,{persist:false}]]);
});

test('模型请求携带对话ID，旧响应不能进入新对话', async () => {
  let finish, sent;
  const client=createAgentClient({getWorkspaceId:()=> 'workspace',request:async(_name,payload)=>{sent=payload;return new Promise(r=>finish=r);}});
  await assert.rejects(client.command({type:'set_model',provider:'fixture',modelId:'first'}));
  assert.equal(sent,undefined);
  client.applyAgentState({sessionId:'A'});
  const promise=client.command({type:'set_model',provider:'fixture',modelId:'first'});
  assert.equal(sent.sessionId,'A'); assert.equal(sent.workspaceId,'workspace');
  client.applyAgentState({sessionId:'B'});
  finish({data:model});
  await assert.rejects(promise,e=>e.staleResponse===true);
});

test('模型切换后读取状态期间换对话，不覆盖新对话界面', async () => {
  let resolveState, current=true, updates=0;
  const state={currentModel:{provider:'fixture',id:'second'}};
  const controls=createModelsController({state,elements:{modelPickerPanel:{classList:{add(){}}}},
    captureContext:()=>()=>current, command:async c=>c.type==='get_state'?new Promise(r=>resolveState=r):{},
    updateStateFromAgent:()=>updates++,showNotice:()=>updates++,showError:()=>updates++});
  const switched=controls.switchModel('fixture','first');
  await new Promise(r=>setImmediate(r)); current=false;
  resolveState({model,sessionId:'A'});await switched;
  assert.equal(updates,0);assert.equal(state.currentModel.id,'second');
});

test('真实SDK：同一工作区各对话独立恢复模型，新对话使用默认设置，重启后仍保留', {
  skip:process.platform!=='win32'||process.env.SUPER_BAODAN_TEST_SDK!=='1'||!findSdkEntry(),timeout:45000,
}, async () => {
  const temp=await createTempProject('sb-session-model-');
  const old={offline:process.env.PI_OFFLINE,agent:process.env.PI_CODING_AGENT_DIR};
  process.env.PI_OFFLINE='1';
  let runtime;
  try {
    await temp.ensureDir('workspace');
    await temp.writeJson('agent/settings.json',{defaultProvider:'fixture',defaultModel:'default',defaultThinkingLevel:'off',enabledModels:['fixture/*'],packages:[]});
    await temp.writeJson('agent/models.json',{providers:{fixture:{baseUrl:'http://127.0.0.1:1/v1',api:'openai-completions',apiKey:'isolated-test-key',models:['default','first','second'].map(id=>({id,name:id,reasoning:false,input:['text'],contextWindow:32000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}))}}});
    runtime=new PiSdkRuntime({cwd:temp.resolve('workspace'),agentDir:temp.resolve('agent'),sessionDir:temp.resolve('sessions'),idleTimeoutMs:600000,log:{warn(){},error(){}}});
    await runtime.ensureStarted();
    const defaults=await readFile(temp.resolve('agent/settings.json'),'utf8');
    const saveFixtureTranscript=()=>{
      const s=runtime.host.session;
      s.sessionManager.appendMessage({role:'user',content:'隔离会话记录',timestamp:Date.now()});
      s.sessionManager.appendMessage({role:'assistant',content:[{type:'text',text:'隔离回复，不调用模型'}],provider:'fixture',model:s.model.id,api:'openai-completions',stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    };
    const first=await runtime.send({type:'get_state'});assert.equal(first.model.id,'default');
    saveFixtureTranscript();
    await runtime.send({type:'set_model',sessionId:first.sessionId,provider:'fixture',modelId:'first'});
    const second=await runtime.newSession();assert.equal(second.model.id,'default');
    saveFixtureTranscript();
    await runtime.send({type:'set_model',sessionId:second.sessionId,provider:'fixture',modelId:'second'});
    await assert.rejects(runtime.send({type:'set_model',sessionId:first.sessionId,provider:'fixture',modelId:'default'}),e=>e.statusCode===409);
    assert.equal((await runtime.openSession(first.sessionFile)).model.id,'first');
    assert.equal((await runtime.openSession(second.sessionFile)).model.id,'second');
    await runtime.stop('idle');await runtime.ensureStarted();
    assert.equal((await runtime.send({type:'get_state'})).model.id,'second');
    assert.equal((await runtime.openSession(first.sessionFile)).model.id,'first');
    assert.equal((await runtime.newSession()).model.id,'default');
    assert.equal(await readFile(temp.resolve('agent/settings.json'),'utf8'),defaults);
  } finally {
    await runtime?.close();
    if(old.offline===undefined)delete process.env.PI_OFFLINE;else process.env.PI_OFFLINE=old.offline;
    if(old.agent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old.agent;
    await temp.cleanup();
  }
});
