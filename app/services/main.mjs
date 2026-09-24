import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRuntimeContext } from './runtime-context.mjs';
import { createCommands } from './commands/index.mjs';
import { AgentClient } from './agent-client.mjs';
import { publicErrorMessage } from '../shared/errors.js';
import { createEventChannel } from './event-channel.mjs';
import { PROCESS_PROTOCOL, hasRequestCapacity } from '../shared/agent-protocol.js';
import { COMMANDS, MAX_MESSAGE_BYTES } from '../shared/commands.js';

const runId=process.env.SUPER_BAODAN_DESKTOP_RUN_ID,root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),dataRoot=process.env.SUPER_BAODAN_DATA_DIR;
if(!runId||!dataRoot||!process.send)throw new Error('应用服务只能由主进程启动');
let context,commands,closing=false,booted=false,initializing,shutdownPromise;
const pending=new Map();
const send=(message,done=()=>{})=>{if(process.connected)process.send({v:PROCESS_PROTOCOL,runId,id:message.id || randomUUID(),name:message.name || message.type,...message},done);else done(new Error('主进程已断开'));};
const events=createEventChannel(send),agent=new AgentClient({send,runId});
process.on('message',message=>{
  if(message?.v!==PROCESS_PROTOCOL||message.runId!==runId)return;
  if(['agent-result','agent-status','agent-event'].includes(message.type)){agent.receive(message);return;}
  if(message.type==='shutdown'){void shutdown();return;}
  if(message.type==='cancel'){pending.get(message.id)?.controller.abort();return;}
  if(message.type==='boot'&&!booted&&!closing){booted=true;initializing=initialize();return;}
  if(message.type!=='invoke'||typeof message.id!=='string')return;
  if(closing||!commands||pending.has(message.id)||!hasRequestCapacity(pending,message.name,message.args))return send({type:'result',id:message.id,name:message.name,error:{code:503,message:'应用服务暂不可用'}});
  if(!COMMANDS.includes(message.name))return send({type:'result',id:message.id,name:message.name,error:{code:404,message:'未知应用操作'}});
  try{if(Buffer.byteLength(JSON.stringify(message.args))>MAX_MESSAGE_BYTES)return send({type:'result',id:message.id,name:message.name,error:{code:413,message:'操作内容过大'}});}
  catch{return send({type:'result',id:message.id,name:message.name,error:{code:400,message:'参数无效'}});}
  const controller=new AbortController();
  const task=Promise.resolve().then(()=>commands.invoke(message.name,message.args,controller.signal))
    .then(value=>send({type:'result',id:message.id,name:message.name,value}),error=>send({type:'result',id:message.id,name:message.name,error:{code:error.statusCode||500,message:publicErrorMessage(error)}}))
    .finally(()=>pending.delete(message.id));
  pending.set(message.id,{name:message.name,args:message.args,controller,task});
});
process.once('disconnect',()=>{void shutdown();setTimeout(()=>process.exit(1),5000).unref();});
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
if(!process.connected)process.exit(1);
send({type:'hello'});
async function initialize() {
  try {
    context=await createRuntimeContext({root,dataRoot,desktopControlled:true,desktopInstanceId:runId,agentClient:agent,
      holidayCacheDir:path.join(dataRoot,'holiday-cache'),backupDir:path.join(dataRoot,'backups'),workspaceDir:path.join(dataRoot,'workspace'),todoFile:path.join(dataRoot,'work-todo.md'),
      appScript:path.join(root,'scripts/open-work-apps.ps1'),piAgentDir:process.env.PI_CODING_AGENT_DIR,piSessionDir:path.join(dataRoot,'sessions'),vskillFile:path.join(dataRoot,'vskills.json'),dailyRecordFile:path.join(dataRoot,'daily-records.json'),workspaceFile:path.join(dataRoot,'workspaces.json'),
      emitEvent:(topic,event)=>events.push(topic,event)});
    commands=createCommands(context);
    if(closing)await shutdown();else{send({type:'ready'});send({type:'agent-state-request'});}
  }catch(error){send({type:'startup-error',message:publicErrorMessage(error)});await context?.shutdown().catch(()=>{});process.exit(1);}
}
function shutdown() {
  closing=true;events.close();agent.close();
  if(!context){if(!initializing)process.exit(0);return Promise.resolve();}
  if(shutdownPromise)return shutdownPromise;
  shutdownPromise=context.shutdown([...pending.values()]).then(()=>{send({type:'shutdown-complete'});process.exit(0);}).catch(error=>send({type:'shutdown-error',message:publicErrorMessage(error)}));return shutdownPromise;
}
