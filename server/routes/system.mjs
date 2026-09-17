import { existsSync } from "node:fs";
import { json, readJsonBody, assertLocalRequest, assertSecureJsonMutation } from "../response.mjs";

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
      desktopInstanceId: config.desktopInstanceId,
      desktopControlled: Boolean(config.desktopControlled),
    });
  });

  router.post("/api/assistant/launch", async (req, res, _url, _match, context) => {
    const body = await readJsonBody(req);
    context.assertActiveWorkspace(body.workspaceId);
    await context.ensureActiveStarted();
    json(res, 200, { ok: true, url: "/assistant.html" });
  });

  router.post("/api/system/shutdown", async (_req, res, _url, _match, context) => {
    if (context.config.desktopControlled) return json(res, 409, { error: "桌面模式请通过应用退出流程关闭" });
    if (context.shuttingDown) return json(res, 202, { ok: true, shuttingDown: true });
    context.shuttingDown = true;
    json(res, 200, { ok: true, shuttingDown: true });
    setTimeout(() => void context.shutdown(), 150).unref();
  });

  router.get('/api/work-documents', async (req, res, _url, _match, context) => {
    assertLocalRequest(req, context.config); json(res, 200, await context.workDocuments.read());
  });
  router.put('/api/work-documents', async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config); json(res, 200, await context.workDocuments.save(await readJsonBody(req)));
  });
  router.post('/api/work-documents/remove', async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config); json(res, 200, await context.workDocuments.remove(await readJsonBody(req)));
  });
  router.post('/api/work-documents/pick-file', async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config); await readJsonBody(req);
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try {
      const result = await context.workDocuments.chooseFile({ signal: controller.signal });
      if (!res.destroyed) json(res, 200, result);
    } catch (error) { if (!res.destroyed) throw error; }
    finally { res.off('close', cancel); }
  });
  router.post('/api/work-documents/open', async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config); json(res, 200, await context.workDocuments.open(await readJsonBody(req)));
  });

  router.get('/api/apps/config', async (req, res, _url, _match, context) => {
    assertLocalRequest(req, context.config);
    json(res, 200, await context.workApps.read());
  });
  router.put('/api/apps/config', async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    json(res, 200, await context.workApps.save(await readJsonBody(req)));
  });
  router.post('/api/apps/open', async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    const body = await readJsonBody(req);
    if (typeof body.id !== 'string' || !/^[\w-]{1,64}$/.test(body.id) || typeof body.revision !== 'string' || !body.revision) return json(res, 400, { error: '缺少软件标识或配置版本' });
    json(res, 200, await context.workApps.run(body.id, body.revision));
  });
  router.post("/api/apps/open-all", async (req, res, _url, _match, context) => {
    assertLocalRequest(req, context.config);
    json(res, 200, await context.openWorkApps());
  });
}
