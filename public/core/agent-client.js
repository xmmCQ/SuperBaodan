import { api, workspacePayload, workspaceUrl } from "./api-client.js?v=1";

export function createAgentClient({
  request = api,
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
    const data = await request(workspaceUrl("/api/agent/bootstrap", getWorkspaceId()), { cache: "no-store", ...options });
    runtime.workspace = data.workspace || runtime.workspace;
    applyAgentState(data.state || {});
    return data;
  }

  function launch(options = {}) {
    return request("/api/assistant/launch", {
      method: "POST",
      body: JSON.stringify(workspacePayload({}, getWorkspaceId())),
      ...options,
    });
  }

  async function command(payload, options = {}) {
    const result = await request("/api/agent/command", {
      method: "POST",
      body: JSON.stringify(workspacePayload(payload, getWorkspaceId())),
      ...options,
    });
    return result.data;
  }

  async function send(message, { images = [], streamingBehavior, launchFirst = false } = {}) {
    if (launchFirst) await launch();
    const payload = { type: "prompt", message };
    if (images.length) payload.images = images;
    if (streamingBehavior) payload.streamingBehavior = streamingBehavior;
    return command(payload);
  }

  return {
    bootstrap,
    launch,
    command,
    send,
    stop: () => command({ type: "abort" }),
    compact: () => command({ type: "compact" }),
    getState: () => command({ type: "get_state" }),
    getMessages: () => command({ type: "get_messages" }),
    applyAgentState,
    applyEvent,
    state: snapshot,
  };
}
