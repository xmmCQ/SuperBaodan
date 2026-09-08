import { preserveReadingPositions } from "./reading-position.js";

const UI_CONTENT = "button, .reply-actions, .message-role, .thinking, .tool-card, .tool-result, .execution-process, .assistant-status, .turn-files-card, .markdown-code-head";
export function messageBodyText(message) {
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}
export function quotedPrompt(instruction, quote) {
  if (!quote?.text) return instruction;
  return `【引用的助手原文${quote.kind === "selection" ? "（选段）" : ""}】\n${quote.text.split(/\r?\n/).map((line) => `> ${line}`).join("\n")}\n\n【我的追问】\n${instruction}`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  const focused = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const field = document.createElement("textarea");
  field.value = text; field.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
  document.body.append(field);
  try { field.select(); if (!document.execCommand("copy")) throw new Error("浏览器未允许复制"); }
  finally {
    field.remove(); focused?.focus?.({ preventScroll: true });
    selection?.removeAllRanges(); for (const range of ranges) selection?.addRange(range);
  }
}

function selectedBodyText(range) {
  const fragment = range.cloneContents();
  fragment.querySelectorAll(UI_CONTENT).forEach((node) => node.remove());
  const block = new Set(["P", "DIV", "LI", "PRE", "TR", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6"]);
  const read = (node) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeName === "BR") return "\n";
    const text = [...node.childNodes].map(read).join("");
    return block.has(node.nodeName) ? `${text}\n` : text;
  };
  return read(fragment).replace(/^\n+|\n+$/g, "");
}

export function createReplyActions({ container, input, quoteBox, getScope, onNotice = () => {} }) {
  const originals = new WeakMap();
  let quote = null, scope, selected = null, selectionFrame = null;
  const floating = document.createElement("button");
  floating.type = "button"; floating.className = "reply-selection-action hidden";
  floating.textContent = "引用选中内容追问";
  floating.setAttribute("aria-label", "引用选中文字，在当前对话追问");
  document.body.append(floating);
  function hideSelection() { selected = null; floating.classList.add("hidden"); }
  function renderQuote() {
    preserveReadingPositions([container], () => {
      quoteBox.replaceChildren(); quoteBox.classList.toggle("hidden", !quote);
      if (!quote) return;
      const header = document.createElement("div"); header.className = "reply-quote-header";
      const label = document.createElement("strong"); label.textContent = quote.kind === "selection" ? "引用选段 · 当前对话追问" : "引用整条回复 · 当前对话追问";
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×";
      remove.title = "取消引用，不清空草稿"; remove.setAttribute("aria-label", "取消引用"); remove.addEventListener("click", clear);
      const text = document.createElement("blockquote"); text.className = "reply-quote-text"; text.textContent = quote.text;
      header.append(label, remove); quoteBox.append(header, text);
    });
  }
  function clear() { quote = null; hideSelection(); renderQuote(); }
  function syncContext() {
    const current = getScope();
    if (current !== scope) { scope = current; if (quote) clear(); else hideSelection(); }
  }
  function choose(text, kind, sourceScope) {
    syncContext();
    if (sourceScope !== scope) { onNotice("对话已切换，请重新选择引用", true); return; }
    quote = { text, kind, scope }; hideSelection(); renderQuote();
    input.focus({ preventScroll: true }); // Never insert over an existing draft.
  }
  function attach(node, message) {
    if (message?.role !== "assistant") return;
    const text = messageBodyText(message);
    if (!text.trim() || originals.has(node)) return;
    syncContext();
    const sourceScope = scope;
    originals.set(node, { text, scope: sourceScope }); node.classList.add("reply-enabled");
    const actions = document.createElement("div"); actions.className = "reply-actions";
    actions.setAttribute("role", "group"); actions.setAttribute("aria-label", "回复操作");
    const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "复制";
    copy.title = "复制整条回复原文（Markdown）"; copy.setAttribute("aria-label", "复制全文");
    let feedbackTimer;
    const feedback = document.createElement("span"); feedback.className = "reply-action-feedback"; feedback.setAttribute("role", "status");
    copy.addEventListener("click", async () => {
      try {
        await copyText(text); copy.textContent = "已复制"; feedback.textContent = "回复原文已复制";
        clearTimeout(feedbackTimer); feedbackTimer = setTimeout(() => { copy.textContent = "复制"; feedback.textContent = ""; }, 1500);
      } catch { onNotice("复制失败，请检查浏览器权限或手动选择原文复制", true); }
    });
    const follow = document.createElement("button"); follow.type = "button"; follow.textContent = "引用追问";
    follow.title = "引用整条回复，在当前对话追问"; follow.setAttribute("aria-label", follow.title);
    follow.addEventListener("click", () => choose(text, "full", sourceScope));
    actions.append(copy, follow, feedback); node.append(actions);
  }
  function captureSelection() {
    selectionFrame = null; syncContext();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) { hideSelection(); return; }
    const range = selection.getRangeAt(0);
    const element = (node) => node.nodeType === 1 ? node : node.parentElement;
    const start = element(range.startContainer), end = element(range.endContainer);
    const owner = start?.closest(".reply-enabled");
    const original = owner && originals.get(owner);
    if (!original || original.scope !== scope || !container.contains(owner) || owner !== end?.closest(".reply-enabled") || start.closest(UI_CONTENT) || end.closest(UI_CONTENT)) { hideSelection(); return; }
    const text = selectedBodyText(range);
    if (!text.trim()) { hideSelection(); return; }
    selected = { text, owner, scope };
    const rect = range.getBoundingClientRect();
    floating.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 240))}px`;
    floating.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 44))}px`;
    floating.classList.remove("hidden");
  }
  function scheduleSelection() {
    if (selectionFrame != null) cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(captureSelection);
  }
  floating.addEventListener("pointerdown", (event) => event.preventDefault());
  floating.addEventListener("click", () => {
    const captured = selected;
    if (captured?.owner.isConnected) choose(captured.text, "selection", captured.scope);
  });
  const onKey = (event) => { if (event.key === "Escape") hideSelection(); };
  document.addEventListener("selectionchange", scheduleSelection);
  document.addEventListener("keydown", onKey);
  container.addEventListener("scroll", hideSelection, { passive: true });
  return {
    attach, syncContext, clear,
    take(instruction) {
      syncContext();
      const ticket = { quote, scope, draft: input.value, message: quotedPrompt(instruction, quote) };
      if (quote) clear();
      return ticket;
    },
    restore(ticket) {
      syncContext();
      if (!ticket || ticket.scope !== scope) return;
      if (!quote && ticket.quote) { quote = ticket.quote; renderQuote(); }
      if (!input.value && ticket.draft) { input.value = ticket.draft; input.dispatchEvent(new Event("input", { bubbles: true })); }
    },
    dispose() {
      if (selectionFrame != null) cancelAnimationFrame(selectionFrame);
      document.removeEventListener("selectionchange", scheduleSelection); document.removeEventListener("keydown", onKey);
      container.removeEventListener("scroll", hideSelection); floating.remove();
    },
  };
}
