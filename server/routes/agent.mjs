import { assertAllowedAgentCommand } from "../../lib/agent-commands.mjs";
import { assertSecureJsonMutation, json, readJsonBody } from "../response.mjs";

export function registerAgentRoutes(router) {
  router.get("/api/agent/events", (req, res, _url, _match, context) => context.openAgentEventStream(req, res));

  router.get("/api/agent/receipt", (_req, res, url, _match, context) => {
    json(res, 200, context.promptReceipts.get(url.searchParams.get("requestId")));
  });

  router.get("/api/agent/snapshot", async (_req, res, url, _match, context) => {
    context.assertActiveWorkspace(url.searchParams.get("workspaceId"));
    if (context.piAdmin.maintenanceActive) return json(res, 409, { error: "配置维护中，请稍后重试" });
    const messages = url.searchParams.get("messages") === "1";
    if (messages && !context.piRuntime.running) await context.ensureActiveStarted();
    json(res, 200, context.piRuntime.snapshot({ messages, since: url.searchParams.get("since") }));
  });

  router.get("/api/agent/bootstrap", async (_req, res, url, _match, context) => {
    context.assertActiveWorkspace(url.searchParams.get("workspaceId"));
    await context.ensureActiveStarted();
    const [state, messages, models, thinking, sessions, preferences, workspaces] = await Promise.all([
      context.piRuntime.send({ type: "get_state" }),
      context.piRuntime.send({ type: "get_messages" }),
      context.safeAgentCommand({ type: "get_available_models" }, { models: [] }),
      context.safeAgentCommand({ type: "get_available_thinking_levels" }, { levels: ["off"] }),
      context.listActiveSessions(),
      context.piAdmin.preferences(),
      context.publicWorkspaceList(),
    ]);
    await context.rememberSessionFromState(state);
    json(res, 200, {
      state,
      messages: messages?.messages || [],
      models: models?.models || [],
      enabledModels: preferences.enabledModels,
      thinkingLevels: thinking?.levels || ["off"],
      sessions,
      workspace: context.publicWorkspace(context.activeWorkspace),
      workspaces,
      turnFiles: context.turnFileSnapshot(),
    });
  });

  router.post("/api/agent/command", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    const body = assertAllowedAgentCommand(await readJsonBody(req));
    const uiResponse = body.type === "extension_ui_response";
    if (!uiResponse && (context.workspaceSwitching || context.piAdmin.maintenanceActive)) {
      return json(res, 409, { error: "工作区或配置正在切换，请稍后重试" });
    }
    if (!uiResponse) context.assertActiveWorkspace(body.workspaceId);
    const receiptPayload = { ...body };
    delete body.workspaceId;
    // Startup dialogs belong to the candidate until the workspace commits.
    const runtime = uiResponse ? context.switchCandidateRuntime || context.piRuntime : context.piRuntime;
    const result = body.type === "prompt" && body.requestId
      ? await context.promptReceipts.submit(body.requestId, receiptPayload, () => runtime.send(body))
      : await runtime.send(body);
    json(res, 200, { ok: true, data: result });
  });

  router.post("/api/agent/new", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    const body = await readJsonBody(req);
    context.assertActiveWorkspace(body.workspaceId);
    context.clearTurnFiles();
    const state = await context.piRuntime.newSession();
    await context.rememberSessionFromState(state);
    json(res, 201, { ok: true, state });
  });
}
