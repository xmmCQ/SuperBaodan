import { registerTaskCommands } from './tasks.mjs';
import { registerAgentCommands } from './agent.mjs';
import { registerAuthCommands } from './auth.mjs';
import { registerDailyRecordCommands } from './daily-records.mjs';
import { registerHolidayCommands } from './holidays.mjs';
import { registerModelCommands } from './models.mjs';
import { registerSessionCommands } from './sessions.mjs';
import { registerSkillCommands } from './skills.mjs';
import { registerSystemCommands } from './system.mjs';
import { registerWorkspaceCommands } from './workspaces.mjs';
import { fault } from '../../shared/errors.js';

export function createCommands(context) {
  const commands = new Map();
  for (const register of [registerTaskCommands, registerAgentCommands, registerAuthCommands, registerDailyRecordCommands, registerHolidayCommands, registerModelCommands, registerSessionCommands, registerSkillCommands, registerSystemCommands, registerWorkspaceCommands]) register(commands);
  commands.set('agent.connect', () => context.agentConnection());
  commands.set('auth.start', args => context.startAuthLogin(args.providerId, args.subscriptionId));
  commands.set('auth.cancel', args => { if (args.subscriptionId === context.authSubscriptionId) context.activeAuthLoginAbort?.abort(); return { ok: true }; });
  return {
    names: [...commands.keys()],
    async invoke(name, args = {}, signal) {
      if (!commands.has(name)) throw fault(404, '未知应用操作');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fault(400, '参数必须为对象');
      if (context.shuttingDown) throw fault(503, '工作台正在退出');
      if (context.workspaceSwitching && !['system.status', 'agent.connect', 'agent.command', 'agent.receipt', 'agent.uiPayload', 'workspaces.activate'].includes(name)) throw fault(409, '工作区正在切换，请稍后重试');
      if (context.piAdmin?.maintenanceActive && ['agent.bootstrap', 'agent.new', 'sessions.rename', 'sessions.delete', 'sessions.activate'].includes(name)) throw fault(409, '登录或配置维护中，请稍后重试');
      if (signal?.aborted) throw fault(499, '操作已取消');
      try {
        return await commands.get(name)(args, context, signal);
      } catch (error) {
        if (signal?.aborted && (error === signal.reason || error?.name === 'AbortError' || error?.code === 'ABORT_ERR')) {
          throw fault(499, '操作已取消');
        }
        throw error;
      }
    },
  };
}
