
export function registerDailyRecordCommands(commands) {
  commands.set("records.list", async (args, context) => {
    return { records: await context.dailyRecordManager.listByDate(args.date) };
  });

  commands.set("records.summary", async (args, context) => {
    return { dates: await context.dailyRecordManager.monthSummary(args.month) };
  });

  commands.set("records.search", async (args, context) => {
    return await context.dailyRecordManager.search(args.q);
  });

  commands.set("records.create", async (args, context) => {
    return { ok: true, record: await context.dailyRecordManager.create(args) };
  });

  commands.set("records.update", async (args, context) => {
    return { ok: true, record: await context.dailyRecordManager.update(args.id, args) };
  });

  commands.set("records.delete", async (args, context) => {
    const body = args;
    return { ok: true, deleted: await context.dailyRecordManager.delete(args.id, body.revision) };
  });
}
