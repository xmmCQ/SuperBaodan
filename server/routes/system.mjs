import { existsSync } from "node:fs";
import { json, readJsonBody } from "../response.mjs";

export function registerSystemRoutes(router) {
  router.get("/api/health", async (_req, res, _url, _match, context) => {
    const { piRuntime, piAdmin, activeWorkspace, config } = context;
    json(res, 200, {
      ok: true,
      runtime: "windows-node-sdk",
      sourceAvailable: existsSync(config.todoFile),
      assistantInstalled: Boolean(piRuntime.findSdkEntry()),
      assistantRunning: piRuntime.running,
      assistantState: piRuntime.state,
      assistantIdleTimeoutMs: piRuntime.idleTimeoutMs,
      assistantMaintenance: piAdmin.maintenanceActive,
      workspaceSwitching: context.workspaceSwitching,
      workspace: context.publicWorkspace(activeWorkspace),
      assistantUrl: "/assistant.html",
      today: context.today(),
    });
  });

  router.post("/api/assistant/launch", async (req, res, _url, _match, context) => {
    const body = await readJsonBody(req);
    context.assertActiveWorkspace(body.workspaceId);
    await context.ensureActiveStarted();
    json(res, 200, { ok: true, url: "/assistant.html" });
  });

  router.post("/api/system/shutdown", async (_req, res, _url, _match, context) => {
    if (context.shuttingDown) return json(res, 202, { ok: true, shuttingDown: true });
    context.shuttingDown = true;
    json(res, 200, { ok: true, shuttingDown: true });
    setTimeout(() => void context.shutdown(), 150).unref();
  });

  router.post("/api/apps/open-all", async (_req, res, _url, _match, context) => {
    try { json(res, 200, await context.openWorkApps()); }
    catch (error) { json(res, 500, { error: `启动工作软件失败：${error.message}` }); }
  });
}
