
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
  commands.set("models.preferences", async (args, context) => {
    return { ok: true, ...(await context.piAdmin.savePreferences(args)) };
  });
}
