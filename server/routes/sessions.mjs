import { searchSessionText } from "../../lib/session-text-search.mjs";
import { captureWorkspace, assertWorkspaceSnapshot, withWorkspaceSnapshot } from '../workspace-operations.mjs';
import { mutationError } from "../../lib/task-writer.mjs";
import { assertSecureJsonMutation, json, readJsonBody } from "../response.mjs";

export function registerSessionRoutes(router) {
  router.get("/api/sessions/search", async (_req, res, url, _match, context) => {
    context.assertActiveWorkspace(url.searchParams.get("workspaceId"));
    if ((context.activeSessionSearches || 0) >= 2) return json(res, 429, { error: "搜索繁忙，请稍后重试" });
    const workspace = context.activeWorkspace;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once("close", cancel);
    context.activeSessionSearches = (context.activeSessionSearches || 0) + 1;
    try {
      const result = await searchSessionText({ sessionDir: context.config.piSessionDir, workspaceRoot: workspace.canonicalRoot, query: url.searchParams.get("q"), signal: controller.signal });
      context.assertActiveWorkspace(workspace.id);
      if (!res.destroyed) json(res, 200, { ...result, workspaceId: workspace.id });
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { res.removeListener("close", cancel); context.activeSessionSearches -= 1; }
  });

  router.get("/api/sessions", async (_req, res, url, _match, context) => {
    context.assertActiveWorkspace(url.searchParams.get("workspaceId"));
    json(res, 200, { sessions: await context.listActiveSessions() });
  });
  router.post("/api/sessions/rename", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    const snapshot = captureWorkspace(context);
    const body = await readJsonBody(req);
    if (typeof body.path !== "string") throw mutationError(400, "缺少会话路径");
    const result = await withWorkspaceSnapshot(context, snapshot, body.workspaceId, async ({ runtime, workspace }) => {
      await context.assertSessionInActiveWorkspace(body.path, runtime, workspace);
      assertWorkspaceSnapshot(context, snapshot, body.workspaceId);
      return runtime.renameSession(body.path, body.name);
    });
    json(res, 200, { ok: true, ...result });
  });
  router.delete("/api/sessions", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    const snapshot = captureWorkspace(context);
    const body = await readJsonBody(req);
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
    json(res, 200, { ok: true, ...result });
  });
  router.post("/api/sessions/activate", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    const snapshot = captureWorkspace(context);
    const body = await readJsonBody(req);
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
    json(res, 200, { ok: true, state });
  });
}
