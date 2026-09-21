import { invoke, workspacePayload } from "./service-client.js?v=1";

export function createSessionService({
  request = invoke,
  agentClient,
  getWorkspaceId = () => null,
} = {}) {
  if (!agentClient) throw new TypeError("agentClient不能为空");

  let mutationSequence = 0, listSequence = 0, mutationTail = null;
  function beginListRead() {
    const sequence = ++listSequence, context = agentClient.captureContext?.() || (() => true);
    return () => sequence === listSequence && context();
  }
  async function mutate(name, args, options) {
    const sequence = ++mutationSequence, workspaceId = getWorkspaceId();
    const workspaceCurrent = agentClient.captureWorkspace?.() || (() => workspaceId === getWorkspaceId());
    const finish = agentClient.beginTransition?.();
    const stale = () => Object.assign(new Error('会话操作响应已过期'), { staleResponse: true });
    const execute = async () => {
      if (!workspaceCurrent()) throw stale();
      return request(name, args, options);
    };
    // Queue in user intent order, including after failures. Invalidate reads
    // when enqueued, but never send a queued operation into another workspace.
    const flight = mutationTail ? mutationTail.catch(() => {}).then(execute) : execute();
    mutationTail = flight;
    try {
      const result = await flight;
      if (sequence !== mutationSequence || !workspaceCurrent()) throw stale();
      return result;
    } catch (error) {
      if (sequence !== mutationSequence || !workspaceCurrent()) throw stale();
      if (!error.staleResponse) error.refreshRequired = () => sequence === mutationSequence && workspaceCurrent();
      throw error;
    } finally {
      if (mutationTail === flight) mutationTail = null;
      finish?.();
    }
  }

  async function list(options = {}) {
    const data = await request("sessions.list", { workspaceId: getWorkspaceId() }, { ...options });
    return data.sessions || [];
  }

  function search(query, options = {}) {
    return request("sessions.search", { q: query, workspaceId: getWorkspaceId() }, { ...options });
  }

  function create(options = {}) {
    return mutate("agent.new", { ...(workspacePayload({}, getWorkspaceId())) }, { ...options });
  }

  function activate(path, options = {}) {
    return mutate("sessions.activate", { ...(workspacePayload({ path }, getWorkspaceId())) }, { ...options });
  }

  function rename(path, name, options = {}) {
    return request("sessions.rename", { ...(workspacePayload({ path, name }, getWorkspaceId())) }, { ...options });
  }

  function remove(path, options = {}) {
    return mutate("sessions.delete", { ...(workspacePayload({ path }, getWorkspaceId())) }, { ...options });
  }

  async function syncCurrent() {
    const current = agentClient.beginRead?.() || (() => true);
    const assertCurrent = () => { if (!current()) throw Object.assign(new Error('对话同步响应已过期'), { staleResponse: true }); };
    const [state, result] = await Promise.all([agentClient.getState(), agentClient.getMessages()]).catch(error => { assertCurrent(); throw error; });
    assertCurrent();
    agentClient.applyAgentState(state || {});
    return { state: state || {}, messages: result?.messages || [], turnFiles: result?.turnFiles, current };
  }

  return { beginListRead, list, search, create, activate, rename, remove, syncCurrent };
}
