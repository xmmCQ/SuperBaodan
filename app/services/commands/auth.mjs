
export function registerAuthCommands(commands) {
  commands.set("auth.providers", async (args, context) => {
    return await context.piAdmin.providers();
  });

  commands.set("auth.input", async (args, context) => {
    const body = args;
    context.piAdmin.submitLoginInput(args.id, body.token, body.value);
    return { ok: true };
  });

  commands.set("auth.logout", async (args, context) => {
    return { ok: true, ...(await context.piAdmin.logout(args.id, "oauth")) };
  });

  commands.set("auth.saveKey", async (args, context) => {
    const body = args;
    return { ok: true, ...(await context.piAdmin.saveApiKey(args.id, body.apiKey)) };
  });

  commands.set("auth.deleteKey", async (args, context) => {
    return { ok: true, ...(await context.piAdmin.logout(args.id, "api_key")) };
  });
}
