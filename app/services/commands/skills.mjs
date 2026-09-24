import { fault } from "../../shared/errors.js";
import { captureWorkspace, withWorkspaceSnapshot } from '../workspace-operations.mjs';

export function registerSkillCommands(commands) {
  commands.set("skills.list", async (args, context) => {
    return await context.skillManager.list();
  });
  commands.set("skills.search", async (args, context) => {
    return await context.skillManager.search(args.q || "");
  });
  for (const action of ["install", "checkUpdates", "update", "uninstall"]) commands.set("skills." + action, mutation(action));
  for (const action of ['transfer', 'openDirectory']) commands.set("skills." + action, async (args, context) => {
    const snapshot = captureWorkspace(context), manager = context.skillManager;
    const body = args;
    if (!body.workspaceId) { throw fault(400, '缺少工作区标识，请刷新后重试'); }
    const result = await withWorkspaceSnapshot(context, snapshot, body.workspaceId, () => manager[action](body));
    return { ok: true, ...result };
  });
  commands.set("skills.setInvocation", mutation("setInvocation"));
  commands.set("skills.createCustom", mutation("createCustom"));
  commands.set("skills.updateCustom", mutation("updateCustom"));
  commands.set("skills.deleteCustom", mutation("deleteCustom"));

}

function mutation(action) {
  return async (args, context) => {
    const result = await context.skillManager[action](args);
    return action === "checkUpdates" ? result : { ok: true, ...result };
  };
}
