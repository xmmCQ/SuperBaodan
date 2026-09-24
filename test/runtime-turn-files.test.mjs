import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentContext } from './helpers/agent-context.mjs';
import { createTempProject } from './helpers/temp-project.mjs';
import { deferred } from './helpers/fake-sdk-host.mjs';

async function setup(t) {
  const temp=await createTempProject('turn-files-');
  const context=await createAgentContext({workspaceDir:temp.resolve('workspace'),piAgentDir:temp.resolve('agent'),piSessionDir:temp.resolve('sessions'),backupDir:temp.resolve('backups'),todoFile:temp.resolve('todo.md'),dailyRecordFile:temp.resolve('records.json')});
  context.broadcastAgentEvent=event=>context.piRuntime.emit('event',event);
  context.normalizeToolPath=async(_root,value)=>value;
  t.after(async()=>{await context.shutdown();await temp.cleanup();});return context;
}
const start=(id,toolName='write',path='file.txt')=>({type:'tool_execution_start',toolCallId:id,toolName,args:{path}});
const end=(id,isError=false)=>({type:'tool_execution_end',toolCallId:id,toolName:'write',isError});
const flush=()=>new Promise(setImmediate);

test('tool start only involved; successful end confirms by ID; errors preserve earlier success',async t=>{
  const c=await setup(t);
  c.broadcastAgentEvent(start('first'));await flush();assert.deepEqual(c.turnFileSnapshot(),{involved:['file.txt'],modified:[]});
  c.broadcastAgentEvent(end('unknown'));assert.deepEqual(c.turnFileSnapshot().modified,[]);
  c.broadcastAgentEvent(end('first'));assert.deepEqual(c.turnFileSnapshot().modified,['file.txt']);
  c.broadcastAgentEvent(start('failure'));await flush();c.broadcastAgentEvent(end('failure',true));assert.deepEqual(c.turnFileSnapshot().modified,['file.txt']);
  c.broadcastAgentEvent(start('read','read','read.txt'));await flush();c.broadcastAgentEvent(end('read'));assert.deepEqual(c.turnFileSnapshot().modified,['file.txt']);
  c.broadcastAgentEvent(start('missing-status','edit','missing.txt'));await flush();c.broadcastAgentEvent({type:'tool_execution_end',toolCallId:'missing-status'});assert.ok(!c.turnFileSnapshot().modified.includes('missing.txt'));
});
test('end before async path normalization is correlated without premature modification',async t=>{
  const c=await setup(t),gate=deferred();c.normalizeToolPath=()=>gate.promise;
  c.broadcastAgentEvent(start('slow','edit'));c.broadcastAgentEvent(end('slow'));assert.deepEqual(c.turnFileSnapshot(),{involved:[],modified:[]});
  c.broadcastAgentEvent({type:'agent_settled'});gate.resolve('file.txt');await flush();assert.deepEqual(c.turnFileSnapshot(),{involved:['file.txt'],modified:['file.txt']});
});
for(const boundary of ['agent_start','runtime_stopping','runtime_exit','workspace','clear'])test(`late normalization/end cannot cross ${boundary}`,async t=>{
  const c=await setup(t),gate=deferred();c.normalizeToolPath=()=>gate.promise;
  c.broadcastAgentEvent(start('old'));c.broadcastAgentEvent(end('old'));
  if(boundary==='workspace')c.services={...c.services,toolCalls:new Map(),turnFiles:{involved:new Set(),modified:new Set()}};
  else if(boundary==='clear')c.clearTurnFiles();else c.broadcastAgentEvent({type:boundary});
  gate.resolve('old.txt');await flush();c.broadcastAgentEvent(end('old'));assert.deepEqual(c.turnFileSnapshot(),{involved:[],modified:[]});
});
test('cancelled/failed calls and reused ID normalization do not produce false modifications',async t=>{
  const c=await setup(t),old=deferred(),fresh=deferred();let n=0;c.normalizeToolPath=()=>(++n===1?old:fresh).promise;
  c.broadcastAgentEvent(start('same'));c.broadcastAgentEvent(start('same'));c.broadcastAgentEvent(end('same',true));old.resolve('wrong.txt');fresh.resolve('failed.txt');await flush();assert.deepEqual(c.turnFileSnapshot(),{involved:['failed.txt'],modified:[]});
  c.normalizeToolPath=async(_root,value)=>value;c.broadcastAgentEvent(start('cancel'));await flush();c.broadcastAgentEvent({type:'agent_settled'});c.broadcastAgentEvent(end('cancel'));assert.deepEqual(c.turnFileSnapshot().modified,[]);
});
