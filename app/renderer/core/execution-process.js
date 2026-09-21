import { messageBodyText } from "./reply-actions.js";
import { preserveReadingPositions } from "./reading-position.js";

export function executionLabel(phase, lastMessage, failed = 0) {
  const active = { running: "正在执行", retrying: "正在重试", stopping: "正在停止", stopped: "已停止", failed: "执行失败", interrupted: "执行中断" };
  let label = active[phase];
  if (!label) {
    const reason = lastMessage?.stopReason;
    label = reason === "stop" ? "已完成" : reason === "aborted" ? "已停止" : reason === "error" ? "执行失败" : reason === "length" ? "输出达到上限，未完整完成" : "执行记录（完成状态未确认）";
  }
  return label + (failed ? ` · ${failed} 个失败步骤` : "");
}

// Root message nodes and their absolute indexes remain in place for pagination
// and directory navigation. Only execution details move into one turn drawer.
export function createExecutionProcess({ container, getScope, getWorkspaceRoot = () => "" }) {
  let scope, sequence = 0, current = "start", indexed = [], occurrences = new Map();
  const metadata = new WeakMap(), turns = new Map(), chunks = new Map(), disclosure = new Map(), facts = new Map();
  function normalizePath(file) {
    let path = String(file).replace(/\\/g, '/');
    if (!/^(?:[a-z]:\/|\/)/i.test(path)) path = `${getWorkspaceRoot()}/${path}`.replace(/\\/g, '/');
    const parts = [];
    for (const part of path.split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); }
    return parts.join('/').toLowerCase();
  }
  function recordFacts(key, message) {
    if (!facts.has(key)) facts.set(key, { calls: new Map(), results: new Map() });
    const fact = facts.get(key);
    for (const part of Array.isArray(message.content) ? message.content : []) {
      const path = part.arguments?.path ?? part.arguments?.file_path ?? part.arguments?.filePath;
      if (part.type === 'toolCall' && ['write', 'edit'].includes(part.name) && part.id && typeof path === 'string') fact.calls.set(part.id, path);
    }
    if (message.role === 'toolResult' && message.toolCallId) fact.results.set(message.toolCallId, message.isError);
  }
  function confirmedFiles(key = current) {
    const fact = facts.get(key);
    return new Set(fact ? [...fact.calls].filter(([id]) => fact.results.has(id) && fact.results.get(id) === false).map(([, path]) => normalizePath(path)) : []);
  }
  function syncScope() {
    const next = getScope();
    if (next === scope) return;
    scope = next; current = "start"; indexed = []; occurrences = new Map();
    for (const turn of turns.values()) turn.drawer.remove();
    turns.clear(); chunks.clear(); disclosure.clear(); facts.clear();
  }
  function userKey(message, counts) {
    const text = messageBodyText(message), count = (counts.get(text) || 0) + 1;
    counts.set(text, count); return JSON.stringify([text, count]);
  }
  function turnFor(key) {
    if (turns.has(key)) return turns.get(key);
    const drawer = document.createElement("details"); drawer.className = "execution-process";
    const summary = document.createElement("summary"), label = document.createElement("span"), action = document.createElement("span");
    label.className = "execution-label"; action.className = "execution-action"; action.textContent = "查看执行过程";
    summary.append(label, action);
    const body = document.createElement("div"); body.className = "execution-steps";
    drawer.append(summary, body);
    const turn = { id: ++sequence, drawer, label, action, body, phase: null, manual: undefined, events: new Map(), members: [] };
    // Record intent synchronously, rather than relying on delayed toggle events.
    summary.addEventListener("click", () => { turn.manual = !drawer.open; });
    drawer.addEventListener("execution-reveal", () => { turn.manual = true; drawer.open = true; });
    drawer.addEventListener("toggle", () => { action.textContent = drawer.open ? "收起执行过程" : "查看执行过程"; });
    turns.set(key, turn); return turn;
  }
  function setMessages(messages, running = false) {
    syncScope(); const counts = new Map(); let key = "start";
    facts.clear();
    indexed = messages.map((message) => { if (message.role === "user") key = userKey(message, counts); recordFacts(key, message); return key; });
    current = key; occurrences = counts;
    const turn = turnFor(current);
    if (running && !["retrying", "stopping"].includes(turn.phase)) turn.phase = "running";
    if (!running && ["running", "retrying", "stopping"].includes(turn.phase)) turn.phase = turn.phase === "stopping" ? "stopped" : null;
  }
  function register(node, message, index, { live = false } = {}) {
    syncScope();
    let key = indexed[index];
    if (key == null) {
      key = message.role === "user" ? userKey(message, occurrences) : current;
      if (message.role === "user" && !["running", "retrying", "stopping"].includes(turns.get(current)?.phase)) current = key;
    }
    recordFacts(key, message);
    const previous = metadata.get(node);
    const id = message.toolCallId || message.timestamp || previous?.id || (live ? "live" : index != null ? `index-${index}` : Symbol());
    const bubble = node.querySelector(".bubble");
    const parts = [];
    if (message.role !== "user" && bubble) {
      const intermediate = message.stopReason === "toolUse";
      let candidates = [...bubble.children].filter((part) => part.matches(".thinking, .tool-card, .tool-result") || (intermediate && part.matches(".markdown-body")));
      if (!candidates.length && previous) candidates = previous.parts;
      const ordinals = {}, toolCalls = (Array.isArray(message.content) ? message.content : []).filter((part) => part.type === 'toolCall');
      candidates.forEach((candidate) => {
        let chunk = candidate;
        if (candidate.matches(".tool-result")) {
          chunk = document.createElement("details"); chunk.className = "execution-result";
          const title = document.createElement("summary"); title.textContent = `工具结果 · ${message.toolName || "tool"}`;
          chunk.append(title, candidate);
        }
        // Timestamp/tool id keys survive snapshots. Live nodes retain their own id.
        const kind = chunk.matches('.thinking') ? 'thinking' : chunk.matches('.tool-card') ? 'tool' : chunk.matches('.markdown-body') ? 'text' : 'result';
        const ordinal = ordinals[kind] || 0; ordinals[kind] = ordinal + 1;
        const toolId = kind === 'tool' ? toolCalls[ordinal]?.id : message.toolCallId;
        const chunkKey = typeof id === "symbol" ? null : JSON.stringify([turnFor(key).id, id, kind, toolId || ordinal]);
        const old = chunkKey && chunks.get(chunkKey);
        const remembered = chunkKey && disclosure.get(chunkKey);
        if (!old && remembered) { chunk.open = remembered.open; chunk.dataset.executionTouched = remembered.touched; }
        if (old && old !== chunk && old.tagName === chunk.tagName) {
          const from = chunk.querySelector(":scope > div"), to = old.querySelector(":scope > div");
          if (chunk.matches('.markdown-body') && old.textContent !== chunk.textContent) old.replaceChildren(...chunk.childNodes);
          else if (from && to && from.textContent !== to.textContent) to.textContent = from.textContent;
          candidate.remove(); chunk = old;
        }
        if (message.isError === true) {
          chunk.classList.add("execution-failure");
          const title = chunk.querySelector("summary");
          if (title && !title.textContent.startsWith("失败 · ")) title.textContent = `失败 · ${title.textContent}`;
          if (chunk.dataset.executionTouched !== "true") chunk.open = true;
        }
        if (!chunk.dataset.executionBound) {
          chunk.dataset.executionBound = "true";
          chunk.querySelector("summary")?.addEventListener("click", () => { chunk.dataset.executionTouched = "true"; });
        }
        if (toolId) chunk.dataset.executionToolId = toolId;
        if (index != null) chunk.dataset.executionMessageIndex = index;
        if (chunkKey) chunks.set(chunkKey, chunk);
        parts.push(chunk); chunk.remove();
      });
    }
    metadata.set(node, { key, id, message, parts });
    node.classList.toggle("execution-source", message.role !== "user" && !bubble?.textContent.trim());
  }
  function refresh(activeOnly = false) {
    syncScope();
    const selected = () => [...turns.entries()].filter(([key]) => !activeOnly || key === current).map(([, turn]) => turn);
    for (const turn of selected()) { turn.members = []; turn.drawer.remove(); }
    for (const node of container.querySelectorAll(":scope > .message")) {
      const info = metadata.get(node);
      if (info && (!activeOnly || info.key === current)) turnFor(info.key).members.push({ node, ...info });
    }
    for (const turn of selected()) {
      const members = turn.members.filter((item) => item.message.role !== "user");
      if (!members.length) { turn.body.replaceChildren(); continue; }
      const cards = members.flatMap(({ node }) => [...node.querySelectorAll('.turn-files-card')]);
      cards.slice(0, -1).forEach((card) => card.remove());
      for (const item of members) item.node.classList.toggle("execution-source", !item.node.querySelector('.bubble')?.textContent.trim());
      const parts = members.flatMap((item) => item.parts);
      const errors = members.filter((item) => item.message.isError === true || item.message.stopReason === "error");
      const failedIds = new Set(errors.map((item) => item.message.toolCallId || item.id));
      for (const [id, event] of turn.events) if (event.failed) failedIds.add(id);
      const calls = new Set();
      for (const item of members) for (const part of Array.isArray(item.message.content) ? item.message.content : []) if (part.type === "toolCall") calls.add(part.id || part);
      for (const id of turn.events.keys()) calls.add(id);
      const last = members.findLast((item) => item.message.role === "assistant")?.message;
      const label = executionLabel(turn.phase, last, failedIds.size);
      if (!parts.length && !failedIds.size && !["retrying", "stopping", "stopped", "failed", "interrupted"].includes(turn.phase) && !["aborted", "error", "length"].includes(last?.stopReason)) continue;
      const modified = confirmedFiles(members[0].key).size;
      turn.label.textContent = label + (modified ? ` · 已确认修改 ${modified} 个文件` : '') + (calls.size ? ` · ${calls.size} 次工具调用` : "");
      turn.drawer.classList.toggle("has-failure", failedIds.size > 0 || turn.phase === "failed" || last?.stopReason === "error");
      for (const part of parts) {
        if (!turn.events.get(part.dataset.executionToolId)?.failed) continue;
        part.classList.add('execution-failure');
        const summary = part.querySelector('summary');
        if (summary && !summary.textContent.startsWith('失败 · ')) summary.textContent = `失败 · ${summary.textContent}`;
        if (part.dataset.executionTouched !== 'true') part.open = true;
      }
      turn.body.replaceChildren(...parts);
      if (failedIds.size && !parts.some((part) => part.classList.contains("execution-failure"))) {
        const warning = document.createElement("p"); warning.className = "execution-failure";
        warning.textContent = errors.find((item) => item.message.errorMessage)?.message.errorMessage || "有步骤执行失败；已收到的参数和日志保留在此处。";
        turn.body.append(warning);
      }
      if (turn.manual !== undefined) turn.drawer.open = turn.manual;
      else turn.drawer.open = failedIds.size > 0 || last?.stopReason === "error";
      turn.action.textContent = turn.drawer.open ? "收起执行过程" : "查看执行过程";
      const host = members.findLast((item) => !item.node.classList.contains("execution-source")) || members.at(-1);
      host.node.classList.remove("execution-source");
      host.node.querySelector(".bubble").append(turn.drawer);
    }
    if (!activeOnly) {
      const used = new Set([...turns.values()].flatMap((turn) => turn.members.flatMap((member) => member.parts)));
      for (const [key, chunk] of chunks) if (!used.has(chunk)) {
        disclosure.set(key, { open: chunk.open, touched: chunk.dataset.executionTouched }); chunks.delete(key);
      }
    }
  }
  function event(event) {
    if (event.type === "message_end" && event.message?.role === "user") {
      const users = [...container.querySelectorAll(':scope > .message.user')].map((node) => metadata.get(node));
      const user = users.findLast((info) => info && messageBodyText(info.message) === messageBodyText(event.message));
      if (user) current = user.key;
      return;
    }
    if (!["agent_start", "auto_retry_start", "auto_retry_end", "message_start", "tool_execution_start", "tool_execution_end", "stopping", "stop_failed", "runtime_exit", "agent_settled"].includes(event.type)) return;
    syncScope(); const turn = turnFor(current);
    if (event.type === "agent_start") { turn.phase = "running"; turn.events.clear(); }
    if (event.type === "auto_retry_start") turn.phase = "retrying";
    if (event.type === "auto_retry_end") turn.phase = event.success === false ? "failed" : "running";
    if (event.type === "message_start" && turn.phase === "retrying") turn.phase = "running";
    if (event.type === "tool_execution_start" && event.toolCallId) turn.events.set(event.toolCallId, { failed: false });
    if (event.type === "tool_execution_end" && event.toolCallId) turn.events.set(event.toolCallId, { failed: event.isError === true });
    if (event.type === "stopping") turn.phase = "stopping";
    if (event.type === "stop_failed") turn.phase = "running";
    if (event.type === "runtime_exit" && ["running", "retrying", "stopping"].includes(turn.phase)) turn.phase = "interrupted";
    if (event.type === "agent_settled") turn.phase = turn.phase === "stopping" ? "stopped" : turn.phase === "failed" ? "failed" : null;
    change(() => refresh(true));
  }
  const change = (operation) => preserveReadingPositions([container, ...container.querySelectorAll('.execution-process .tool-result')], operation);
  return { setMessages, register, refresh, event, change, isConfirmedFile: (file) => confirmedFiles().has(normalizePath(file)) };
}
