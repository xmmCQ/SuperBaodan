import { fault } from '../../shared/errors.js';

export function registerModelCommands(commands) {
  commands.set("models.read", async (args, context) => {
    return await context.piAdmin.readModelsConfig();
  });
  commands.set("models.save", async (args, context) => {
    return { ok: true, ...(await context.piAdmin.saveModelsConfig(args)) };
  });
  commands.set("models.test", async (args, context) => {
    return await context.piAdmin.testModel(args);
  });
  commands.set("models.catalog", async (args, context) => {
    return await context.piAdmin.catalog();
  });
  for (const [command, method] of [['models.refresh','refreshCatalog'],['models.saveDisplay','saveDisplayPreferences'],['models.saveDefaults','saveDefaultPreferences']]) {
    commands.set(command, async (args, context, signal) => {
      if (context.workspaceSwitching || context.shuttingDown) throw fault(409, '工作区正在切换或服务正在退出，请稍后重试');
      const admin = context.piAdmin;
      const result = await admin[method](args,{signal});
      if (context.piAdmin === admin) context.emitAgentEvent?.({type:'models_changed',workspaceId:context.activeWorkspace?.id,catalog:result});
      return {ok:true,...result};
    });
  }
}
