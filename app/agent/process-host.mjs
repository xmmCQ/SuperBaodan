import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PROCESS_PROTOCOL, checkAgentRequest, hasRequestCapacity } from '../shared/agent-protocol.js';
import { createEventChannel } from '../services/event-channel.mjs';
import { publicErrorMessage } from '../shared/errors.js';

export function serveAgent({createContext} = {}) {
const runId=process.env.SUPER_BAODAN_DESKTOP_RUN_ID,dataRoot=process.env.SUPER_BAODAN_DATA_DIR;
if(!runId||!dataRoot||!process.send)throw new Error('Agent只能由主进程启动');
let booted=false,closing=false,context,contextPromise,contextError,shutdownPromise,lastStatus;
const pending=new Map();
const installed=existsSync(path.join(process.env.SUPER_BAODAN_PI_PACKAGE || path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent'),'dist/index.js'));
function send(message,done=()=>{}) {
  if(!process.connected)return done();
  try { process.send({v:PROCESS_PROTOCOL,runId,id:message.id || randomUUID(),name:message.name || message.type,...message},done); } catch { done(); }
}
const events=createEventChannel(send);
function publish() {
  const value={...(context?.status() || {state:contextError?'error':'stopped',error:contextError,running:false,sessionGeneration:0}),installed,pid:process.pid};
  const key=JSON.stringify(value);if(key===lastStatus)return;lastStatus=key;
  send({type:'agent-status',name:'agent.status',scope:context?.scope(),value:JSON.parse(key)});
}
function getContext() {
  if(!contextPromise)contextPromise=import('./agent-context.mjs').then(async({AgentContext})=>{
    const build = createContext || ((config,dependencies)=>new AgentContext(config,dependencies));
    context=await build({piAgentDir:process.env.PI_CODING_AGENT_DIR,piSessionDir:process.env.SUPER_BAODAN_SESSION_DIR,backupDir:process.env.SUPER_BAODAN_BACKUP_DIR,todoFile:process.env.SUPER_BAODAN_TODO_FILE,dailyRecordFile:process.env.SUPER_BAODAN_DAILY_RECORD_FILE},{
      emit:(topic,event,scope)=>events.push(topic,event,{scope,name:event.type}),publish,
    });
    if(closing)await context.beginShutdown();return context;
  }).catch(error=>{contextError=publicErrorMessage(error);publish();throw error;});
  return contextPromise;
}
process.on('message',message=>{
  if(message?.v!==PROCESS_PROTOCOL||message.runId!==runId)return;
  if(message.type==='shutdown'){void shutdown();return;}
  if(message.type==='cancel'){pending.get(message.id)?.controller.abort();return;}
  if(message.type==='boot'&&!booted&&!closing){booted=true;send({type:'ready'});publish();return;}
  if(message.type!=='invoke'||!booted||!checkAgentRequest(message))return;
  if(closing||pending.has(message.id)||!hasRequestCapacity(pending,message.name,message.args)){send({type:'result',id:message.id,name:message.name,scope:message.scope,error:{code:429,message:'Agent繁忙或正在退出'}});return;}
  const controller=new AbortController();
  const task=Promise.resolve().then(async()=>{
    const owner=await getContext();return owner.invoke(message.name,message.args,message.scope,controller.signal);
  }).then(value=>{
    // JSON data only: never send SDK instances/functions across the boundary.
    const copy=value===undefined?null:JSON.parse(JSON.stringify(value));
    send({type:'result',id:message.id,name:message.name,scope:message.scope,value:copy});
  }).catch(error=>send({type:'result',id:message.id,name:message.name,scope:message.scope,error:{code:error.statusCode||500,message:publicErrorMessage(error)}})).finally(()=>{pending.delete(message.id);publish();});
  pending.set(message.id,{name:message.name,args:message.args,controller,task});
});
process.once('disconnect',()=>{void shutdown();setTimeout(()=>process.exit(1),5000).unref();});
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
if(!process.connected)process.exit(1);
send({type:'hello'});
function shutdown() {
  closing=true;events.close();for(const item of pending.values())item.controller.abort();
  context?.beginShutdown();
  if(shutdownPromise)return shutdownPromise;
  shutdownPromise=(async()=>{
    if(contextPromise)await contextPromise.catch(()=>{});
    if(context)await context.shutdown([...pending.values()].map(item=>item.task));
    send({type:'shutdown-complete'});process.exit(0);
  })().catch(error=>send({type:'shutdown-error',message:publicErrorMessage(error)}));return shutdownPromise;
}
}
