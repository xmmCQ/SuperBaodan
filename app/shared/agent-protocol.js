import { COMMANDS, MAX_MESSAGE_BYTES, MAX_PENDING_REQUESTS } from './commands.js';
export const PROCESS_PROTOCOL = 1;
export const MAX_AGENT_REQUESTS = 96;
export const MAX_CONTROL_REQUESTS = 16;
export const AGENT_COMMANDS = Object.freeze(COMMANDS.filter(name =>
  /^(auth|models|skills)\./.test(name) || ['agent.start','agent.bootstrap','agent.command','agent.new','agent.snapshot','agent.receipt','agent.uiPayload','sessions.activate','sessions.rename','sessions.delete','projectPrompt.save'].includes(name)));
export const AGENT_INTERNAL_COMMANDS = Object.freeze([...AGENT_COMMANDS,
  'control.configure','control.prepareWorkspace','control.commitWorkspace','control.rollbackWorkspace','control.operation','control.quiesce']);
export function isAgentRequest(name) { return AGENT_COMMANDS.includes(name) || name === 'workspaces.activate'; }
export function isControlRequest(name, args = {}) {
  return ['auth.input','auth.cancel','agent.uiPayload','agent.receipt','control.operation','control.quiesce','control.commitWorkspace','control.rollbackWorkspace'].includes(name) || (name === 'agent.command' && ['abort','extension_ui_response','abort_retry','abort_bash'].includes(args.type));
}
export function hasRequestCapacity(pending, name, args) {
  const entries = [...pending.values()];
  if (pending.size >= MAX_PENDING_REQUESTS) return false;
  if (isControlRequest(name,args)) return entries.filter(item=>isControlRequest(item.name,item.args)).length < MAX_CONTROL_REQUESTS;
  if (pending.size >= MAX_PENDING_REQUESTS - 4) return false;
  return !isAgentRequest(name) || entries.filter(item=>isAgentRequest(item.name)&&!isControlRequest(item.name,item.args)).length < MAX_AGENT_REQUESTS;
}
export function validProcessMessage(message, runId) {
  return message?.v === PROCESS_PROTOCOL && message.runId === runId && typeof message.type === 'string';
}
export function checkAgentRequest(message) {
  if (typeof message.id !== 'string' || !/^[\w-]{1,128}$/.test(message.id) || !AGENT_INTERNAL_COMMANDS.includes(message.name)) return false;
  if (!message.args || typeof message.args !== 'object' || Array.isArray(message.args)) return false;
  try { return Buffer.byteLength(JSON.stringify(message.args)) <= MAX_MESSAGE_BYTES; } catch { return false; }
}
export function scopeMatches(left, right) {
  return left?.workspaceId === right?.workspaceId && left?.workspaceEpoch === right?.workspaceEpoch;
}
