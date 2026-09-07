import { mutationError } from "../../lib/task-writer.mjs";
import { assertSecureJsonMutation, json, readJsonBody } from "../response.mjs";

export function registerSessionRoutes(router) {
  router.get("/api/sessions", async (_req, res, url, _match, context) => {
    context.assertActiveWorkspace(url.searchParams.get("workspaceId"));
    json(res, 200, { sessions: await context.listActiveSessions() });
  });
  router.post("/api/sessions/rename", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    const body = await readJsonBody(req); context.assertActiveWorkspace(body.workspaceId);
    if (typeof body.path !== "string") throw mutationError(400, "缺少会话路径");
    await context.assertSessionInActiveWorkspace(body.path);
    json(res, 200, { ok: true, ...(await context.piRuntime.renameSession(body.path, body.name)) });
  });
  router.delete("/api/sessions", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    const body = await readJsonBody(req); context.assertActiveWorkspace(body.workspaceId);
    if (typeof body.path !== "string") throw mutationError(400, "缺少会话路径");
    const session = await context.assertSessionInActiveWorkspace(body.path);
    const result = await context.piRuntime.deleteSession(body.path);
    if (session.id === context.activeWorkspace.lastSessionId) {
      await context.workspaceRegistry.setActive(context.activeWorkspace.id, null);
      context.activeWorkspace = context.workspaceRegistry.active();
    }
    json(res, 200, { ok: true, ...result });
  });
  router.post("/api/sessions/activate", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    const body = await readJsonBody(req); context.assertActiveWorkspace(body.workspaceId);
    if (typeof body.path !== "string") throw mutationError(400, "缺少会话路径");
    const session = await context.assertSessionInActiveWorkspace(body.path);
    context.clearTurnFiles();
    const state = await context.piRuntime.openSession(body.path);
    await context.workspaceRegistry.rememberSession(context.activeWorkspace.id, session.id);
    context.activeWorkspace = context.workspaceRegistry.active();
    json(res, 200, { ok: true, state });
  });
}
