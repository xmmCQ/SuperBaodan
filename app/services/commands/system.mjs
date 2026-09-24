import { fault } from "../../shared/errors.js";
import { existsSync } from "node:fs";

export function registerSystemCommands(commands) {
  commands.set("system.status", async (args, context) => {
    const { activeWorkspace, config } = context;
    const agent=context.agent?.snapshot || {};
    return {
      ok: true,
      runtime: "windows-node-sdk",
      sourceAvailable: existsSync(config.todoFile),
      assistantInstalled: agent.installed !== false,
      assistantRunning: Boolean(agent.running),
      assistantState: agent.state || 'stopped',
      assistantIdleTimeoutMs: agent.idleTimeoutMs,
      assistantMaintenance: Boolean(agent.maintenance),
      agentProcessState: agent.processState || 'idle',
      agentRunId: agent.agentRunId || null,
      workspaceSwitching: context.workspaceSwitching,
      workspace: context.publicWorkspace(activeWorkspace),
      assistantUrl: "/assistant.html",
      today: context.today(),
      desktopInstanceId: config.desktopInstanceId,
      desktopControlled: Boolean(config.desktopControlled),
    };
  });

  commands.set("documents.read", async (args, context) => {
    return await context.workDocuments.read();
  });
  commands.set("documents.save", async (args, context) => {
    return await context.workDocuments.save(args);
  });
  commands.set("documents.remove", async (args, context) => {
    return await context.workDocuments.remove(args);
  });
  commands.set("documents.open", async (args, context) => {
    return await context.workDocuments.open(args);
  });

  commands.set("apps.read", async (args, context) => {
    return await context.workApps.read();
  });
  commands.set("apps.save", async (args, context) => {
    return await context.workApps.save(args);
  });
  commands.set("apps.open", async (args, context) => {
    const body = args;
    if (typeof body.id !== 'string' || !/^[\w-]{1,64}$/.test(body.id) || typeof body.revision !== 'string' || !body.revision) throw fault(400, '缺少软件标识或配置版本');
    return await context.workApps.run(body.id, body.revision);
  });
  commands.set("apps.openAll", async (args, context) => {
    return await context.workApps.run();
  });
}
