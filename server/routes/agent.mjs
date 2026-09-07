import { assertAllowedAgentCommand } from "../../lib/agent-commands.mjs";
import { assertSecureJsonMutation, json, readJsonBody } from "../response.mjs";

export function registerAgentRoutes(router) {
  router.get("/api/agent/events", (req, res, _url, _match, context) => context.openAgentEventStream(req, res));

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
    const body = await readJsonBody(req);
    context.assertActiveWorkspace(body.workspaceId);
    delete body.workspaceId;
    const result = await context.piRuntime.send(assertAllowedAgentCommand(body));
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
