import { mkdir, realpath } from 'node:fs/promises';
import { AgentContext } from '../../app/agent/agent-context.mjs';

// Agent-owned domain harness, not a local-process SDK proxy.
export async function createAgentContext(config, dependencies = {}) {
  await mkdir(config.workspaceDir,{recursive:true});
  const root=await realpath(config.workspaceDir);
  const context=new AgentContext(config,dependencies);
  await context.configure({workspace:{id:'agent-workspace',name:'隔离工作区',root,canonicalRoot:root},epoch:0});
  return context;
}
export const agentCommands = context => ({invoke:(name,args={},signal)=>context.invoke(name,args,context.scope(),signal)});
