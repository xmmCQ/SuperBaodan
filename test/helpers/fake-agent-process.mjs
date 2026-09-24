// Test-only Agent executable. No SDK, accounts or inference calls.
import { PROCESS_PROTOCOL as v } from '../../app/shared/agent-protocol.js';
import { spawn } from 'node:child_process';
const runId=process.env.SUPER_BAODAN_DESKTOP_RUN_ID;let workspace,epoch=0;const holds=new Map();
const send=message=>process.connected&&process.send({v,runId,...message});
const state=()=>({installed:true,state:'ready',running:true,workspaceId:workspace?.id,workspaceEpoch:epoch,sessionGeneration:1,session:{sessionId:'fake-session',isStreaming:false},pendingUi:[],pid:process.pid});
process.on('message',message=>{
  if(message.v!==v||message.runId!==runId)return;
  const reply=value=>send({type:'result',id:message.id,name:message.name,scope:message.scope,value});
  const event=event=>send({type:'event',topic:'agent',name:event.type,scope:message.scope,event});
  if(message.type==='boot'){send({type:'ready',name:'ready'});send({type:'agent-status',name:'agent.status',value:state()});return;}
  if(message.type==='shutdown'){for(const release of holds.values())release({cancelled:true});process.exit(0);}
  if(message.type==='cancel'){holds.get(message.id)?.({cancelled:true});holds.delete(message.id);return;}
  if(message.type!=='invoke')return;
  if(message.name==='control.configure'){workspace=message.args.workspace;epoch=message.args.epoch;send({type:'agent-status',name:'agent.status',value:state()});reply(state());return;}
  if(message.args?.fixture==='block'){
    event({type:'fixture_block',pid:process.pid});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,message.args.blockMs ?? 5000);reply({done:true});return;
  }
  if(message.args?.fixture==='hold'){holds.set(message.id,reply);event({type:'fixture_held',count:holds.size});return;}
  if(message.args?.fixture==='crash'){process.exit(17);}
  if(message.args?.fixture==='spawn-block'){
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    event({type:'fixture_child',pid:child.pid,parent:process.pid});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000);reply({});return;
  }
  if(message.name==='auth.cancel'){for(const release of holds.values())release({released:true});holds.clear();reply({ok:true});return;}
  if(message.name==='agent.start'){reply({ok:true,url:'/assistant.html'});return;}
  if(message.name==='agent.receipt'){reply({status:'unknown'});return;}
  if(message.name==='agent.bootstrap'){reply({state:state().session,messages:[],models:[],thinkingLevels:['off'],enabledModels:[]});return;}
  reply({ok:true});
});
process.on('disconnect',()=>process.exit(0));
if(!process.connected)process.exit(1);send({type:'hello',name:'hello'});
