import { EventEmitter } from 'node:events';
import { createRuntimeContext } from '../../app/services/runtime-context.mjs';
import { AgentContext } from '../../app/agent/agent-context.mjs';

// Typed in-memory transport for domain tests; production always uses process IPC.
export async function linkedContexts(config, dependencies = {}) {
  const client=new EventEmitter();client.snapshot={processState:'connected',agentRunId:'test-run'};
  const local=await createRuntimeContext({...config,agentClient:client});
  const agent=new AgentContext(config,{...dependencies,
    emit:(topic,event,scope)=>client.emit('event',{topic,event,scope}),
    publish:()=>{const previous=client.snapshot;client.snapshot=JSON.parse(JSON.stringify({...agent.status(),processState:'connected',agentRunId:'test-run'}));client.emit('status',client.snapshot,previous);},
  });
  client.ensureConnected=async()=>{};
  client.configure=(args)=>agent.configure(args);
  client.invoke=(name,args,options={})=>agent.invoke(name,JSON.parse(JSON.stringify(args)),options.scope,options.signal);
  client.adoptScope=()=>{};client.receiptKnown=()=>true;client.close=()=>{};
  client.markUnavailable=message=>{client.snapshot={...client.snapshot,processState:'failed',state:'error',error:message};};
  await client.configure({workspace:local.activeWorkspace,epoch:local.workspaceEpoch});
  return {local,agent};
}
