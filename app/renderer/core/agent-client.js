import { invoke, ApplicationError, workspacePayload } from "./service-client.js?v=1";
import { validatePromptPayload } from '../../shared/prompt-images.js';

export function createAgentClient({
  request = invoke,
  getWorkspaceId = () => null,
} = {}) {
  const runtime = {
    runtimeState: "stopped",
    running: false,
    streaming: false,
    sessionId: null,
    sessionFile: null,
    workspace: null,
  };

  let bootstrapSequence = 0, workspaceEpoch = 0, readSequence = 0, transitions = 0, contentRevision = 0, workspaceRevision = 0;
  const staleResponse = () => Object.assign(new Error('对话响应已过期'), { staleResponse: true });
  function invalidateContext() { workspaceEpoch += 1; readSequence += 1; }
  function beginTransition() {
    transitions += 1; invalidateContext();
    return () => { transitions -= 1; invalidateContext(); };
  }
  function captureContext({ allowTransition = false } = {}) {
    const epoch = workspaceEpoch, workspaceId = getWorkspaceId() || runtime.workspace?.id || null;
    return () => (allowTransition || !transitions) && epoch === workspaceEpoch && (!workspaceId || workspaceId === (getWorkspaceId() || runtime.workspace?.id || null));
  }
  function captureWorkspace() {
    const revision = workspaceRevision, id = getWorkspaceId() || runtime.workspace?.id || null;
    return () => revision === workspaceRevision && id === (getWorkspaceId() || runtime.workspace?.id || null);
  }
  function beginRead() {
    const sequence = ++readSequence, epoch = workspaceEpoch, content = contentRevision;
    const workspaceId = getWorkspaceId() || runtime.workspace?.id || null;
    const available = !transitions;
    return () => available && !transitions && sequence === readSequence && epoch === workspaceEpoch && content === contentRevision &&
      (!workspaceId || workspaceId === (getWorkspaceId() || runtime.workspace?.id || null));
  }
  const bootstrapTickets = new WeakMap();
  const staleBootstrap = () => Object.assign(new Error('初始化响应已过期'), { staleResponse: true });
  function bootstrapCurrent(data) {
    const ticket = bootstrapTickets.get(data);
    if (!ticket || ticket.sequence !== bootstrapSequence || ticket.epoch !== workspaceEpoch || !ticket.current()) return false;
    const current = getWorkspaceId() || runtime.workspace?.id || null;
    return (!ticket.workspaceId || ticket.workspaceId === current) && (!current || !data.workspace?.id || data.workspace.id === current);
  }

  function snapshot() {
    return { ...runtime };
  }

  function applyAgentState(agentState = {}) {
    if (agentState.sessionId !== undefined) runtime.sessionId = agentState.sessionId || null;
    if (agentState.sessionFile !== undefined) runtime.sessionFile = agentState.sessionFile || null;
    if (agentState.isStreaming !== undefined) {
      runtime.running = Boolean(agentState.isStreaming);
      runtime.streaming = runtime.running;
      if (runtime.running) runtime.runtimeState = "busy";
    }
    return snapshot();
  }

  function applyEvent(event = {}) {
    if (['message_start', 'message_update', 'message_end', 'workspace_turn_files'].includes(event.type)) contentRevision += 1;
    if (['agent_start', 'agent_settled', 'runtime_stopping', 'runtime_exit'].includes(event.type) || (event.type === 'runtime_ready' && runtime.sessionId && event.state?.sessionId !== runtime.sessionId)) invalidateContext();
    if ((event.type === 'workspace_changed' && !event.renamed) || (event.type === 'connected' && event.workspace?.id && runtime.workspace?.id && event.workspace.id !== runtime.workspace.id)) { workspaceRevision += 1; invalidateContext(); }
    switch (event.type) {
      case "connected":
        runtime.runtimeState = event.state || (event.running ? "running" : "stopped");
        runtime.running = event.state === "busy";
        runtime.streaming = runtime.running;
        if (event.workspace) runtime.workspace = event.workspace;
        break;
      case "runtime_ready":
        runtime.runtimeState = "ready";
        applyAgentState(event.state || {});
        break;
      case "runtime_stopping":
        runtime.runtimeState = "stopping";
        break;
      case "runtime_idle":
        runtime.runtimeState = "idle";
        runtime.running = false;
        runtime.streaming = false;
        break;
      case "runtime_stopped":
        runtime.runtimeState = "stopped";
        break;
      case "runtime_exit":
        runtime.runtimeState = "error";
        runtime.running = false;
        runtime.streaming = false;
        break;
      case "agent_start":
        runtime.runtimeState = "busy";
        runtime.running = true;
        runtime.streaming = true;
        break;
      case "agent_settled":
        runtime.runtimeState = "ready";
        runtime.running = false;
        runtime.streaming = false;
        break;
      case "workspace_changed":
        if (event.workspace) runtime.workspace = event.workspace;
        break;
    }
    return snapshot();
  }

  async function bootstrap(options = {}) {
    const ticket = { sequence: ++bootstrapSequence, workspaceId: getWorkspaceId() || runtime.workspace?.id || null, epoch: workspaceEpoch, current: beginRead() };
    let data;
    try { data = await request("agent.bootstrap", { workspaceId: ticket.workspaceId }, { timeout: 0, ...options }); }
    catch (error) {
      if (ticket.sequence !== bootstrapSequence || ticket.epoch !== workspaceEpoch || !ticket.current() || (ticket.workspaceId && ticket.workspaceId !== (getWorkspaceId() || runtime.workspace?.id || null))) throw staleBootstrap();
      throw error;
    }
    bootstrapTickets.set(data, ticket);
    if (!bootstrapCurrent(data)) throw staleBootstrap();
    runtime.workspace = data.workspace || runtime.workspace;
    applyAgentState(data.state || {});
    return data;
  }

  function launch(options = {}) {
    return request("agent.start", { ...(workspacePayload({}, getWorkspaceId())) }, { ...options });
  }

  async function command(payload, options = {}) {
    const modelChange = payload.type === 'set_model';
    const sessionId = runtime.sessionId;
    const current = modelChange ? captureContext() : null;
    if (modelChange && (!sessionId || !current())) {
      throw new ApplicationError('对话尚未就绪，请稍后选择模型', { status: 409 });
    }
    const scoped = modelChange ? { ...payload, sessionId } : payload;
    const result = await request("agent.command", { ...(workspacePayload(scoped, getWorkspaceId())) }, { timeout: payload.type.startsWith("get_") ? 15000 : 0, ...options });
    if (modelChange && (!current() || runtime.sessionId !== sessionId)) throw staleResponse();
    return result.data;
  }

  async function send(message, { images = [], streamingBehavior, launchFirst = false, signal, timeout = 0 } = {}) {
    const workspaceId = getWorkspaceId();
    validatePromptPayload({ message, images });
    if (launchFirst) await launch();
    if (workspaceId !== getWorkspaceId()) throw new ApplicationError('工作区已变化，消息未发送', { status: 409 });
    if (signal?.aborted) throw new ApplicationError("消息尚未发送，请求已取消");
    const requestId = crypto.randomUUID();
    const payload = { type: "prompt", message, requestId };
    if (images.length) payload.images = images;
    if (streamingBehavior) payload.streamingBehavior = streamingBehavior;
    validatePromptPayload(workspacePayload(payload, workspaceId));
    try { return await command(payload, { signal, timeout }); }
    catch (error) {
      // Cancellation/timeout may arrive after the service accepted a prompt.
      if (error.status && error.status < 500 && ![408, 499].includes(error.status)) throw error;
      let receipt;
      try { receipt = await request("agent.receipt", { requestId: requestId }, { timeout: 5000 }); }
      catch { /* Unreachable/expired receipts remain unknown. Never resend. */ }
      if (receipt?.status === "accepted") return null;
      if (receipt?.status === "rejected") throw new ApplicationError(receipt.error || "消息未被受理", { status: 409 });
      throw Object.assign(new ApplicationError(receipt?.status === "pending" ? "消息已到达，正在确认受理状态，请勿重复发送" : "暂时无法确认消息是否受理，请同步对话后确认，勿重复发送"), { acceptanceUnknown: true, requestId });
    }
  }

  async function getSnapshot({ messages = false, since, ...options } = {}) {
    const current = beginRead();
    const query = new URLSearchParams();
    if (messages) query.set("messages", "1");
    if (since != null) query.set("since", since);
    const data = await request("agent.snapshot", { ...(Object.fromEntries(query)), workspaceId: getWorkspaceId() }, { timeout: 15000, ...options });
    if (!current()) throw staleResponse();
    return { ...data, current };
  }

  return {
    captureContext, captureWorkspace, beginRead, beginTransition, invalidateContext,
    bootstrap,
    bootstrapCurrent,
    launch,
    command,
    send,
    stop: () => command({ type: "abort" }),
    compact: () => command({ type: "compact" }),
    getSnapshot,
    getState: (options) => command({ type: "get_state" }, options),
    getMessages: (options) => command({ type: "get_messages" }, options),
    applyAgentState,
    applyEvent,
    state: snapshot,
  };
}
