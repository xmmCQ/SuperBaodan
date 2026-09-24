export function createAssistantState() {
  return {
    chat: {
      running: false,
      streaming: false,
      live: null,
      activeTools: new Map(),
      images: [],
      lastAgentEventAt: 0,
      responsePoll: null,
    },
    sessions: { sessions: [], currentSessionId: null },
    models: {
      models: [], enabledModels: [], visibleModelKeys: null, currentModel: null,
      modelsConfig: null, modelsConfigSnapshot: null,
      providerKey: null, modelIndex: 0,
    },
    auth: { activeLoginSource: null, secretProvider: null },
    skills: {
      skills: null, skillDiagnostics: [], skillCliAvailable: false,
      selectedSkillId: null, skillUpdates: {}, skillAdding: false,
      skillAddMode: "market", skillEditorRaw: false, skillCreateRaw: false,
      skillMarketQuery: "", skillSearchResults: [], skillBusy: false,
    },
    workspace: {
      turnFiles: { involved: [], modified: [] }, previewPath: null,
      workspace: null, workspaceReloadTimer: null,
    },
  };
}
