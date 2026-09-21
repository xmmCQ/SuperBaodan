import { randomUUID } from "node:crypto";

// Preserve the existing browser extension_ui_request / response protocol.
export function createSdkUi({ emit, theme, onPendingChange = () => {} }) {
  const pending = new Map();
  let closed = false;
  const notify = (method, fields = {}) => {
    if (!closed) emit({ type: "extension_ui_request", id: randomUUID(), method, ...fields });
  };
  function ask(request, fallback, parse, options = {}) {
    if (closed || options.signal?.aborted) return Promise.resolve(fallback);
    const id = randomUUID();
    return new Promise((resolve) => {
      let timer;
      const finish = (value) => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
        onPendingChange(pending.size);
        resolve(value);
      };
      const cancel = () => finish(fallback);
      pending.set(id, {
        cancel,
        respond: (response) => finish(response.cancelled ? fallback : parse(response)),
        event: { type: "extension_ui_request", id, ...request, timeout: options.timeout },
      });
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.timeout > 0) timer = setTimeout(cancel, options.timeout);
      onPendingChange(pending.size);
      emit(pending.get(id).event);
    });
  }
  const noop = () => {};
  const ui = {
    select: (title, options, opts) => ask({ method: "select", title, options }, undefined, (r) => options.includes(r.value) ? r.value : undefined, opts),
    confirm: (title, message, opts) => ask({ method: "confirm", title, message }, false, (r) => r.confirmed === true, opts),
    input: (title, placeholder, opts) => ask({ method: "input", title, placeholder }, undefined, (r) => typeof r.value === "string" ? r.value : undefined, opts),
    editor: (title, prefill) => ask({ method: "editor", title, prefill }, undefined, (r) => typeof r.value === "string" ? r.value : undefined),
    notify: (message, type) => notify("notify", { message, notifyType: type }),
    setStatus: (key, text) => notify("setStatus", { statusKey: key, statusText: text }),
    setWidget: (key, content, options) => {
      if (content === undefined || Array.isArray(content)) notify("setWidget", { widgetKey: key, widgetLines: content, widgetPlacement: options?.placement });
    },
    setTitle: (title) => notify("setTitle", { title }),
    setEditorText: (text) => notify("set_editor_text", { text }),
    pasteToEditor: (text) => notify("set_editor_text", { text }),
    getEditorText: () => "",
    theme,
    getAllThemes: () => [], getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Web界面不支持终端主题切换" }),
    getToolsExpanded: () => false, setToolsExpanded: noop,
    onTerminalInput: () => noop,
    custom: async () => undefined,
    setWorkingMessage: noop, setWorkingVisible: noop, setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop, setFooter: noop, setHeader: noop,
    addAutocompleteProvider: noop, setEditorComponent: noop, getEditorComponent: () => undefined,
  };
  const cancelAll = () => { for (const item of [...pending.values()]) item.cancel(); };
  return {
    ui,
    respond(response) {
      const request = pending.get(response.id);
      if (request) request.respond(response);
      return null;
    },
    cancelAll,
    close() { closed = true; cancelAll(); },
    requests: () => [...pending.values()].map((item) => item.event),
  };
}

// SDK events include a growing partial message; the browser expects compact
// RPC-shaped deltas. Do not serialize the entire message on every token.
export function toBrowserAgentEvent(event) {
  if (event.type !== "message_update") return boundBrowserAgentEvent(event);
  const { partial, ...delta } = event.assistantMessageEvent;
  if (delta.type === "toolcall_start") {
    const call = partial?.content?.[delta.contentIndex] || event.message?.content?.[delta.contentIndex];
    if (call?.type === "toolCall") Object.assign(delta, { id: call.id, toolName: call.name });
  }
  return boundBrowserAgentEvent({ type: "message_update", usage: event.message?.usage, assistantMessageEvent: delta });
}

// Full message bodies remain available from /api/agent/snapshot. Lifecycle
// signals and tool identities must survive even when their bodies are large.
export const MAX_BROWSER_EVENT_BYTES = 64 * 1024;
export function boundBrowserAgentEvent(event) {
  if (event.type === "extension_ui_request" || Buffer.byteLength(JSON.stringify(event)) <= MAX_BROWSER_EVENT_BYTES) return event;
  const compact = { type: event.type, snapshotRequired: true };
  for (const key of ["toolCallId", "toolName", "isError", "willRetry", "id", "attempt", "maxAttempts", "error", "errorMessage"]) {
    const value = event[key];
    if (["string", "number", "boolean"].includes(typeof value) && Buffer.byteLength(JSON.stringify(value)) <= 2048) compact[key] = value;
  }
  if (event.type === "tool_execution_start") {
    const toolPath = event.args?.path ?? event.args?.file_path ?? event.args?.filePath;
    if (typeof toolPath === "string" && Buffer.byteLength(toolPath) <= 8192) compact.args = { path: toolPath };
  }
  return compact;
}
