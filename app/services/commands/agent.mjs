import { AGENT_COMMANDS } from '../../shared/agent-protocol.js';

// SDK operations are named requests, never remote object/property proxies.
export function registerAgentCommands(commands) {
  for(const name of AGENT_COMMANDS)commands.set(name,(args,context,signal)=>context.forwardAgent(name,args,signal));
}
