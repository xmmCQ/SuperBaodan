import { api, workspacePayload, workspaceUrl } from "./api-client.js?v=1";

export function createSessionService({
  request = api,
  agentClient,
  getWorkspaceId = () => null,
} = {}) {
  if (!agentClient) throw new TypeError("agentClient不能为空");

  async function list(options = {}) {
    const data = await request(workspaceUrl("/api/sessions", getWorkspaceId()), { cache: "no-store", ...options });
    return data.sessions || [];
  }

  function search(query, options = {}) {
    return request(workspaceUrl(`/api/sessions/search?q=${encodeURIComponent(query)}`, getWorkspaceId()), { cache: "no-store", ...options });
  }

  function create(options = {}) {
    return request("/api/agent/new", {
      method: "POST",
      body: JSON.stringify(workspacePayload({}, getWorkspaceId())),
      ...options,
    });
  }

  function activate(path, options = {}) {
    return request("/api/sessions/activate", {
      method: "POST",
      body: JSON.stringify(workspacePayload({ path }, getWorkspaceId())),
      ...options,
    });
  }

  function rename(path, name, options = {}) {
    return request("/api/sessions/rename", {
      method: "POST",
      body: JSON.stringify(workspacePayload({ path, name }, getWorkspaceId())),
      ...options,
    });
  }

  function remove(path, options = {}) {
    return request("/api/sessions", {
      method: "DELETE",
      body: JSON.stringify(workspacePayload({ path }, getWorkspaceId())),
      ...options,
    });
  }

  async function syncCurrent() {
    const [state, result] = await Promise.all([agentClient.getState(), agentClient.getMessages()]);
    agentClient.applyAgentState(state || {});
    return { state: state || {}, messages: result?.messages || [] };
  }

  return { list, search, create, activate, rename, remove, syncCurrent };
}
