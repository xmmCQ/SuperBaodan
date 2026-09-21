import { captureWorkspace, assertWorkspaceSnapshot, withWorkspaceSnapshot } from '../workspace-operations.mjs';
import { fault } from "../../shared/errors.js";
import { MAX_UI_RESPONSE_BYTES } from '../ui-event-payloads.mjs';
import { assertAllowedAgentCommand } from "../domain/agent-commands.mjs";
import { validatePromptPayload } from '../../shared/prompt-images.js';


export function registerAgentCommands(commands) {

  commands.set("agent.uiPayload", (args, context) => {
    context.assertActiveWorkspace(args.workspaceId);
    const runtime = context.switchCandidateRuntime || context.piRuntime;
    return context.uiEventPayloads.get(args.token, runtime, context.workspaceEpoch, args.workspaceId);
  });

  commands.set("agent.receipt", (args, context) => {
    return context.promptReceipts.get(args.requestId);
  });

  commands.set('agent.snapshot', async (args, context, signal) => {
    const snapshot = captureWorkspace(context, args.workspaceId);
    if (snapshot.admin.maintenanceActive) throw fault(409, '配置维护中，请稍后重试');
    const messages = args.messages === '1';
    const read = () => ({ ...snapshot.runtime.snapshot({ messages, since: args.since }), turnFiles: context.turnFileSnapshot() });
    if (!messages || snapshot.runtime.running) return read();
    return withWorkspaceSnapshot(context, snapshot, args.workspaceId, async () => {
      await context.ensureActiveStarted(snapshot);
      assertWorkspaceSnapshot(context, snapshot);
      return read();
    }, { signal, maintenance: true });
  });

  commands.set('agent.bootstrap', async (args, context, signal) => {
    const snapshot = captureWorkspace(context, args.workspaceId);
    return withWorkspaceSnapshot(context, snapshot, args.workspaceId, async ({ runtime, workspace, admin }) => {
      await context.ensureActiveStarted(snapshot);
      const [state, messages, models, thinking, sessions, preferences, workspaces] = await Promise.all([
        runtime.send({ type: 'get_state' }),
        runtime.send({ type: 'get_messages' }),
        context.safeAgentCommand({ type: 'get_available_models' }, { models: [] }, runtime),
        context.safeAgentCommand({ type: 'get_available_thinking_levels' }, { levels: ['off'] }, runtime),
        context.listActiveSessions(runtime, workspace),
        admin.preferences(),
        context.publicWorkspaceList(),
      ]);
      await context.rememberSessionFromState(state, snapshot);
      return {
        state,
        messages: messages?.messages || [],
        models: models?.models || [],
        enabledModels: preferences.enabledModels,
        thinkingLevels: thinking?.levels || ['off'],
        sessions,
        workspace: context.publicWorkspace(workspace),
        workspaces,
        turnFiles: context.turnFileSnapshot(),
      };
    }, { signal, maintenance: true });
  });

  commands.set("agent.command", async (args, context) => {
    const body = assertAllowedAgentCommand(args);
    if (body.type === 'prompt') validatePromptPayload(body);
    else if (Buffer.byteLength(JSON.stringify(body), 'utf8') > (body.type === 'extension_ui_response' ? MAX_UI_RESPONSE_BYTES : 1024 * 1024)) throw fault(413, '请求内容过大');
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

  commands.set('agent.new', async (args, context, signal) => {
    const snapshot = captureWorkspace(context, args.workspaceId);
    return withWorkspaceSnapshot(context, snapshot, args.workspaceId, async ({ runtime }) => {
      const state = await runtime.newSession();
      await context.rememberSessionFromState(state, snapshot);
      context.clearTurnFiles();
      return { ok: true, state };
    }, { signal, maintenance: true });
  });
}
