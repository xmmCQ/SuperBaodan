import { fault } from "../../shared/errors.js";
import { searchSessionText } from "../domain/session-text-search.mjs";
import { captureWorkspace, assertWorkspaceSnapshot, withWorkspaceSnapshot } from '../workspace-operations.mjs';
import { mutationError } from "../domain/task-writer.mjs";

export function registerSessionCommands(commands) {
  commands.set("sessions.search", async (args, context, signal) => {
    context.assertActiveWorkspace(args.workspaceId);
    if ((context.activeSessionSearches || 0) >= 2) throw fault(429, "搜索繁忙，请稍后重试");
    const workspace = context.activeWorkspace;
    context.activeSessionSearches = (context.activeSessionSearches || 0) + 1;
    try {
      const result = await searchSessionText({ sessionDir: context.config.piSessionDir, workspaceRoot: workspace.canonicalRoot, query: args.q, signal });
      context.assertActiveWorkspace(workspace.id);
      return { ...result, workspaceId: workspace.id };
    }
    finally { context.activeSessionSearches -= 1; }
  });

  commands.set("sessions.list", async (args, context, signal) => {
    context.assertActiveWorkspace(args.workspaceId);
    return { sessions: await context.listActiveSessions() };
  });
  commands.set("sessions.rename", async (args, context, signal) => {
    const snapshot = captureWorkspace(context);
    const body = args;
    if (typeof body.path !== "string") throw mutationError(400, "缺少会话路径");
    const result = await withWorkspaceSnapshot(context, snapshot, body.workspaceId, async ({ runtime, workspace }) => {
      await context.assertSessionInActiveWorkspace(body.path, runtime, workspace);
      assertWorkspaceSnapshot(context, snapshot, body.workspaceId);
      return runtime.renameSession(body.path, body.name);
    });
    return { ok: true, ...result };
  });
  commands.set("sessions.delete", async (args, context, signal) => {
    const snapshot = captureWorkspace(context);
    const body = args;
    if (typeof body.path !== "string") throw mutationError(400, "缺少会话路径");
    const result = await withWorkspaceSnapshot(context, snapshot, body.workspaceId, async ({ runtime, workspace }) => {
      const session = await context.assertSessionInActiveWorkspace(body.path, runtime, workspace);
      assertWorkspaceSnapshot(context, snapshot, body.workspaceId);
      const deleted = await runtime.deleteSession(body.path);
      assertWorkspaceSnapshot(context, snapshot, body.workspaceId);
      if (session.id === context.workspaceRegistry.active().lastSessionId) {
        await context.workspaceRegistry.setActive(workspace.id, null);
        context.activeWorkspace = context.workspaceRegistry.active();
      }
      return deleted;
    });
    return { ok: true, ...result };
  });
  commands.set("sessions.activate", async (args, context, signal) => {
    const snapshot = captureWorkspace(context);
    const body = args;
    if (typeof body.path !== "string") throw mutationError(400, "缺少会话路径");
    const state = await withWorkspaceSnapshot(context, snapshot, body.workspaceId, async ({ runtime, workspace }) => {
      const session = await context.assertSessionInActiveWorkspace(body.path, runtime, workspace);
      assertWorkspaceSnapshot(context, snapshot, body.workspaceId);
      const opened = await runtime.openSession(body.path);
      assertWorkspaceSnapshot(context, snapshot, body.workspaceId);
      context.clearTurnFiles();
      await context.workspaceRegistry.rememberSession(workspace.id, session.id);
      context.activeWorkspace = context.workspaceRegistry.active();
      return opened;
    });
    return { ok: true, state };
  });
}
