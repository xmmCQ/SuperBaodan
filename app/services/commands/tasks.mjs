
export function registerTaskCommands(commands) {
  commands.set("tasks.dashboard", async (args, context) => {
    const month = validMonth(args.month) || context.today().slice(0, 7);
    const { tasks, updatedAt, stale, warning } = await context.taskStore.loadTasks();
    return { ...context.dashboard(tasks, month), updatedAt, stale, warning };
  });
  commands.set("tasks.day", async (args, context) => {
    const { tasks, updatedAt, stale, warning } = await context.taskStore.loadTasks();
    return { date: args.id, tasks: context.dayDetails(tasks, args.id), updatedAt, stale, warning };
  });
  commands.set("tasks.create", taskMutation("create"));
  commands.set("tasks.move", taskMutation("move"));
  commands.set("tasks.update", taskMutation("update"));
  commands.set("tasks.delete", taskMutation("delete"));
}

function taskMutation(kind) {
  return async (args, context) => {
    const body = args;
    const result = await context.taskStore.mutateTask(kind, body.revision, args.id, body);
    return { ok: true, updatedAt: result.updatedAt };
  };
}

function validMonth(value) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "") ? value : null; }
