import { registerTaskCommands } from './tasks.mjs';
import { registerAgentCommands } from './agent.mjs';
import { registerDailyRecordCommands } from './daily-records.mjs';
import { registerHolidayCommands } from './holidays.mjs';
import { registerSessionCommands } from './sessions.mjs';
import { registerVSkillCommands } from './vskills.mjs';
import { registerSystemCommands } from './system.mjs';
import { registerWorkspaceCommands } from './workspaces.mjs';
import { isControlRequest } from '../../shared/agent-protocol.js';
import { fault } from '../../shared/errors.js';

const independent=name=>/^(tasks|records|vskills|apps|documents|holidays)\./.test(name)||['system.status','agent.connect','agent.receipt','workspaces.list','workspaces.browse','workspaces.activate'].includes(name);
export function createCommands(context) {
  const commands=new Map();
  for(const register of [registerTaskCommands,registerDailyRecordCommands,registerHolidayCommands,registerSessionCommands,registerVSkillCommands,registerSystemCommands,registerWorkspaceCommands,registerAgentCommands])register(commands);
  commands.set('agent.connect',()=>context.agentConnection());
  return {names:[...commands.keys()],async invoke(name,args={},signal){
    if(!commands.has(name))throw fault(404,'未知应用操作');
    if(!args||typeof args!=='object'||Array.isArray(args))throw fault(400,'参数必须为对象');
    if(context.shuttingDown)throw fault(503,'工作台正在退出');
    if(context.workspaceSwitching&&!independent(name)&&!isControlRequest(name,args))throw fault(409,'工作区正在切换，请稍后重试');
    if(signal?.aborted)throw fault(499,'操作已取消');
    try{return await commands.get(name)(args,context,signal);}
    catch(error){if(signal?.aborted&&(error===signal.reason||error?.name==='AbortError'||error?.code==='ABORT_ERR'))throw fault(499,'操作已取消');throw error;}
  }};
}
