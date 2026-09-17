import { fault } from "../../shared/errors.js";
import { MAX_UI_RESPONSE_BYTES } from '../ui-event-payloads.mjs';
import { assertAllowedAgentCommand } from "../domain/agent-commands.mjs";
import { validatePromptPayload } from '../../shared/prompt-images.js';
import { mutationError } from '../domain/task-writer.mjs';

export function registerAgentCommands(commands) {

  commands.set("agent.uiPayload", (args, context) => {
    context.assertActiveWorkspace(args.workspaceId);
    const runtime = context.switchCandidateRuntime || context.piRuntime;
    return context.uiEventPayloads.get(args.token, runtime, context.workspaceEpoch, args.workspaceId);
  });

  commands.set("agent.receipt", (args, context) => {
    return context.promptReceipts.get(args.requestId);
  });

  commands.set("agent.snapshot", async (args, context) => {
    context.assertActiveWorkspace(args.workspaceId);
    if (context.piAdmin.maintenanceActive) throw fault(409, "配置维护中，请稍后重试");
    const messages = args.messages === "1";
    if (messages && !context.piRuntime.running) await context.ensureActiveStarted();
    return { ...context.piRuntime.snapshot({ messages, since: args.since }), turnFiles: context.turnFileSnapshot() };
  });

  commands.set("agent.bootstrap", async (args, context) => {
    context.assertActiveWorkspace(args.workspaceId);
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
    return {
      state,
      messages: messages?.messages || [],
      models: models?.models || [],
      enabledModels: preferences.enabledModels,
      thinkingLevels: thinking?.levels || ["off"],
      sessions,
      workspace: context.publicWorkspace(context.activeWorkspace),
      workspaces,
      turnFiles: context.turnFileSnapshot(),
    };
  });

  commands.set("agent.command", async (args, context) => {
    const body = assertAllowedAgentCommand(args);
    if (body.type === 'prompt') validatePromptPayload(body);
    else if (Buffer.byteLength(JSON.stringify(body), 'utf8') > (body.type === 'extension_ui_response' ? MAX_UI_RESPONSE_BYTES : 1024 * 1024)) throw mutationError(413, '请求内容过大');
    const uiResponse = body.type === "extension_ui_response";
    if (!uiResponse && (context.workspaceSwitching || context.piAdmin.maintenanceActive)) {
      throw fault(409, "工作区或配置正在切换，请稍后重试");
    }
    if (!uiResponse) context.assertActiveWorkspace(body.workspaceId);
    const receiptPayload = { ...body };
    delete body.workspaceId;
    // Startup dialogs belong to the candidate until the workspace commits.
    const runtime = uiResponse ? context.switchCandidateRuntime || context.piRuntime : context.piRuntime;
    const result = body.type === "prompt" && body.requestId
      ? await context.promptReceipts.submit(body.requestId, receiptPayload, () => runtime.send(body))
      : await runtime.send(body);
    return { ok: true, data: body.type === "get_messages" ? { ...result, turnFiles: context.turnFileSnapshot() } : result };
  });

  commands.set("agent.new", async (args, context) => {
    const body = args;
    context.assertActiveWorkspace(body.workspaceId);
    context.clearTurnFiles();
    const state = await context.piRuntime.newSession();
    await context.rememberSessionFromState(state);
    return { ok: true, state };
  });
}
