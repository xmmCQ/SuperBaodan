import { messageBodyText } from "./reply-actions.js";
import { MAX_MARKDOWN_LENGTH } from "../markdown-renderer.js";

export function questionLabel(text) {
  const marker = "\n\n【我的追问】\n";
  if (text.startsWith("【引用的助手原文") && text.includes(marker)) text = text.slice(text.lastIndexOf(marker) + marker.length);
  return text.replace(/\s+/g, " ").trim().slice(0, 100) || "图片或空白提问";
}
export function replyHeadings(text, parse, includeShort = false) {
  if (!parse || text.length > MAX_MARKDOWN_LENGTH || !/(?:^|\n) {0,3}#{1,2}\s|\n[=-]{2,}/.test(text)) return [];
  const tokens = parse(text), headings = [];
  tokens.forEach((token, index) => {
    if (token.type !== "heading_open" || !["h1", "h2"].includes(token.tag)) return;
    const inline = tokens[index + 1];
    const label = inline?.children?.map((part) => ["text", "code_inline", "image"].includes(part.type) ? part.content : ["softbreak", "hardbreak"].includes(part.type) ? " " : "").join("") || inline?.content || "标题";
    headings.push({ text: label, level: Number(token.tag.slice(1)), ordinal: headings.length });
  });
  return includeShort || text.length >= 300 || headings.length > 1 ? headings : [];
}
function textBlocks(message) {
  if (!Array.isArray(message.content)) return [messageBodyText(message)];
  const blocks = []; let buffer = "";
  const flush = () => { if (buffer.trim()) blocks.push(buffer); buffer = ""; };
  for (const part of message.content) {
    if (part.type === "text") buffer += String(part.text || "");
    else if (part.type === "toolCall" || (part.type === "thinking" && String(part.thinking || "").trim())) flush();
  }
  flush(); return blocks;
}
export function buildConversationOutline(messages, parse, cache = new Map(), { splitTextBlocks = false } = {}) {
  const turns = [];
  messages.forEach((message, index) => {
    if (message.role === "user") turns.push({ index, label: questionLabel(messageBodyText(message)), headings: [] });
    else if (message.role === "assistant" && turns.length) {
      const text = messageBodyText(message), blocks = splitTextBlocks ? textBlocks(message) : [text];
      const signature = blocks.map((block) => block.length).join(",");
      let cached = cache.get(index);
      if (!cached || cached.text !== text || cached.signature !== signature) {
        let headings = blocks.flatMap((block) => replyHeadings(block, parse, true)).map((heading, ordinal) => ({ ...heading, ordinal }));
        if (text.length < 300 && headings.length < 2) headings = [];
        cached = { text, signature, headings }; cache.set(index, cached);
      }
      for (const heading of cached.headings) turns.at(-1).headings.push({ ...heading, index });
    }
  });
  for (const index of cache.keys()) if (index >= messages.length || messages[index]?.role !== "assistant") cache.delete(index);
  return turns;
}

export function createConversationDirectory({ button, container, getScope, loadEarlier, pauseFollow, onLatest, onNotice = () => {}, splitTextBlocks = false }) {
  const panel = document.createElement("nav"); panel.className = "conversation-directory hidden";
  panel.id = "conversationDirectory"; panel.setAttribute("aria-label", "对话目录");
  panel.innerHTML = '<header><strong>对话目录</strong><button type="button" data-latest>回到最新回复</button><button type="button" data-close aria-label="关闭对话目录">×</button></header><div class="conversation-directory-list"></div>';
  const floatingTools = button.closest(".chat-floating-tools");
  (floatingTools || document.body).append(panel);
  const list = panel.querySelector(".conversation-directory-list");
  button.setAttribute("aria-controls", panel.id); button.setAttribute("aria-expanded", "false");
  let messages = [], turns = [], scope, open = false, dirty = true, frame = null, jump = 0;
  const cache = new Map();
  const engine = globalThis.markdownit?.({ html: false });
  const parse = engine ? (text) => engine.parse(text, {}) : null;
  function cancelJump() { jump += 1; delete container.dataset.directoryJump; }
  function position() {
    if (floatingTools) return; // CSS anchors the panel to the chat-local bubbles.
    const rect = button.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(rect.right - 300, window.innerWidth - 308))}px`;
    panel.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 200))}px`;
  }
  function close(focus = false) {
    open = false; panel.classList.add("hidden"); button.setAttribute("aria-expanded", "false"); button.setAttribute("aria-label", "展开对话目录"); cancelJump();
    if (focus) button.focus({ preventScroll: true });
  }
  function updateActive() {
    frame = null;
    if (!open) return;
    const top = container.getBoundingClientRect().top, bottom = container.getBoundingClientRect().bottom;
    const nodes = [...container.querySelectorAll(":scope > [data-message-index]")];
    const visible = nodes.find((node) => { const rect = node.getBoundingClientRect(); return rect.bottom > top + 10 && rect.top < bottom; });
    const atBottom = container.scrollHeight - container.clientHeight - container.scrollTop < 24;
    const index = atBottom ? messages.length - 1 : visible ? Number(visible.dataset.messageIndex) : messages.length - 1;
    const active = turns.findLast((turn) => turn.index <= index)?.index;
    for (const node of list.querySelectorAll("[data-turn-index]")) {
      const current = Number(node.dataset.turnIndex) === active;
      node.classList.toggle("is-current", current);
      if (current) node.setAttribute("aria-current", "location"); else node.removeAttribute("aria-current");
    }
  }
  function scheduleActive() { if (frame == null && open) frame = requestAnimationFrame(updateActive); }
  async function go(target) {
    if (scope !== getScope()) { close(); onNotice("对话已切换，请重新打开目录"); return; }
    cancelJump(); const request = jump, source = getScope();
    pauseFollow(); container.dataset.directoryJump = "true";
    const valid = () => request === jump && source === getScope();
    let node = container.querySelector(`:scope > [data-message-index="${target.index}"]`);
    const deadline = Date.now() + 10000;
    try {
      while (!node && valid()) {
        if (Date.now() > deadline) throw new Error("历史消息仍在加载，请重试目录跳转");
        const result = loadEarlier();
        if (result === "end") break;
        await new Promise(requestAnimationFrame);
        node = container.querySelector(`:scope > [data-message-index="${target.index}"]`);
      }
      if (!valid()) return;
      if (!node) throw new Error("对应消息尚未加载，请同步对话后重试");
      const moved = [...container.querySelectorAll(`[data-execution-message-index="${target.index}"]`)];
      let destination = node.classList.contains('execution-source') ? moved[0] || node : node;
      if (target.ordinal != null) {
        const headings = [...node.querySelectorAll(".markdown-body h1, .markdown-body h2")].filter((heading) => !heading.closest('.execution-process'));
        if (!headings.length) headings.push(...moved.flatMap((part) => [...part.querySelectorAll('h1, h2')]));
        destination = headings[target.ordinal] || headings.find((heading) => heading.textContent === target.text);
        if (!destination) { destination = node; onNotice("该标题当前以纯文本显示，已定位到对应回复"); }
      }
      for (let parent = destination; parent && parent !== container; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') { parent.open = true; parent.dataset.executionTouched = 'true'; parent.dispatchEvent(new Event('execution-reveal')); }
      }
      const behavior = container.style.scrollBehavior;
      container.style.scrollBehavior = "auto";
      container.scrollTop += destination.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
      await new Promise(requestAnimationFrame);
      if (valid()) updateActive();
      container.style.scrollBehavior = behavior;
    } catch (error) { if (valid()) onNotice(error.message, true); }
    finally { if (valid()) delete container.dataset.directoryJump; }
  }
  function render() {
    const scroll = list.scrollTop, focused = document.activeElement?.dataset.directoryKey;
    turns = buildConversationOutline(messages, parse, cache, { splitTextBlocks }); dirty = false;
    list.replaceChildren();
    if (!turns.length) { const empty = document.createElement("p"); empty.textContent = "暂无用户提问"; list.append(empty); }
    turns.forEach((turn, order) => {
      const item = document.createElement("section"); item.className = "directory-turn";
      const question = document.createElement("button"); question.type = "button";
      question.dataset.turnIndex = turn.index; question.dataset.directoryKey = `turn-${turn.index}`;
      question.className = "directory-question"; question.title = turn.label;
      question.textContent = `${order + 1}. ${turn.label}`;
      question.addEventListener("click", () => void go(turn)); item.append(question);
      for (const heading of turn.headings) {
        const entry = document.createElement("button"); entry.type = "button"; entry.className = `directory-heading level-${heading.level}`;
        entry.dataset.directoryKey = `heading-${heading.index}-${heading.ordinal}`;
        entry.textContent = heading.text; entry.title = heading.text;
        entry.addEventListener("click", () => void go(heading)); item.append(entry);
      }
      list.append(item);
    });
    if (focused) [...list.querySelectorAll("button")].find((node) => node.dataset.directoryKey === focused)?.focus({ preventScroll: true });
    list.scrollTop = scroll; scheduleActive();
  }
  function revealActive() {
    requestAnimationFrame(() => {
      if (!open) return;
      updateActive(); list.querySelector('[aria-current="location"]')?.scrollIntoView({ block: "nearest" });
    });
  }
  button.addEventListener("click", () => {
    if (open) { close(); return; }
    open = true; panel.classList.remove("hidden"); button.setAttribute("aria-expanded", "true"); button.setAttribute("aria-label", "收起对话目录");
    position(); if (dirty) render(); else updateActive(); revealActive();
  });
  panel.querySelector("[data-close]").addEventListener("click", () => close(true));
  panel.querySelector("[data-latest]").addEventListener("click", () => { cancelJump(); onLatest(); revealActive(); });
  const outside = (event) => { if (open && !panel.contains(event.target) && !button.contains(event.target)) close(); };
  const key = (event) => { if (open && event.key === "Escape") { event.preventDefault(); close(true); } };
  document.addEventListener("pointerdown", outside); document.addEventListener("keydown", key);
  container.addEventListener("scroll", scheduleActive, { passive: true });
  container.addEventListener("wheel", cancelJump, { passive: true }); window.addEventListener("resize", position);
  return {
    update(next) {
      const current = getScope();
      if (current !== scope) { scope = current; close(); cache.clear(); list.scrollTop = 0; }
      else if (next.length < messages.length || (messages.length && next.length && (messages[0].role !== next[0].role || messages[0].timestamp !== next[0].timestamp || messageBodyText(messages[0]) !== messageBodyText(next[0])))) { cancelJump(); cache.clear(); }
      messages = next; dirty = true; if (open) render();
    },
    dispose() { close(); if (frame != null) cancelAnimationFrame(frame); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); container.removeEventListener("scroll", scheduleActive); container.removeEventListener("wheel", cancelJump); window.removeEventListener("resize", position); panel.remove(); },
  };
}
