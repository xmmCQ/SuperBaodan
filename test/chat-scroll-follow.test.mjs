import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHomeChat } from "../public/home/home-chat.js";

class ScrollBox {
  constructor() {
    this.scrollHeight = 1000;
    this.clientHeight = 400;
    this._scrollTop = 600;
    this.listeners = new Map();
  }
  get scrollTop() { return this._scrollTop; }
  set scrollTop(value) { this._scrollTop = Math.max(0, Math.min(Number(value) || 0, this.scrollHeight - this.clientHeight)); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type, event = {}) { this.listeners.get(type)?.(event); }
  scrollTo({ top }) { this.scrollTop = top; }
}

const homeSource = await readFile(new URL("../public/home/home-chat.js", import.meta.url), "utf8");
const assistantSource = await readFile(new URL("../public/assistant/chat-view.js", import.meta.url), "utf8");
const assistantModuleSource = assistantSource
  .replace(/^import .*$/m, "const repairToolOutputEncoding = (value) => value;")
  // This unit harness exercises scrolling only; attachment behavior has browser coverage.
  .replace(/^import \{ createImageAttachments, readFileAsDataUrl \}.*$/m, 'const createImageAttachments = () => ({ add() {}, render() {}, clear() {} }); const readFileAsDataUrl = () => {};')
  .replace(/from (["'])(\.[^"']+)\1/g, (_match, _quote, specifier) => `from ${JSON.stringify(new URL(specifier, new URL('../public/assistant/chat-view.js', import.meta.url)).href)}`);
const { createChatView } = await import(`data:text/javascript;base64,${Buffer.from(assistantModuleSource).toString("base64")}`);

test("首页对话在用户上翻后暂停跟随，回到底部后恢复", () => {
  const messages = new ScrollBox();
  const chat = createHomeChat({ state: {}, elements: { chatMessages: messages } });
  messages.scrollTop = 220;
  messages.dispatch("scroll");
  chat.scrollChat();
  assert.equal(messages.scrollTop, 220);
  messages.scrollTop = 600;
  messages.dispatch("scroll");
  messages.scrollHeight = 1100;
  chat.scrollChat();
  assert.equal(messages.scrollTop, 700);
  messages.scrollTop = 300;
  messages.dispatch("wheel", { deltaY: -100 });
  chat.scrollChat(true);
  assert.equal(messages.scrollTop, 700);
});

test("展开助手在用户上翻后暂停跟随，强制场景仍回到底部", () => {
  const originalAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  try {
    const messages = new ScrollBox();
    const chat = createChatView({ state: {}, elements: { messages }, getTurnFiles: () => ({ involved: [], modified: [] }) });
    messages.scrollTop = 180;
    messages.dispatch("scroll");
    chat.scrollBottom();
    assert.equal(messages.scrollTop, 180);
    chat.scrollBottom("auto", true);
    assert.equal(messages.scrollTop, 600);
    messages.scrollTop = 600;
    messages.dispatch("scroll");
    messages.scrollHeight = 1200;
    chat.scrollBottom();
    assert.equal(messages.scrollTop, 800);
  } finally {
    globalThis.requestAnimationFrame = originalAnimationFrame;
  }
});

test("流式同步保留阅读位置，发送和首次加载允许强制跟随", () => {
  assert.match(homeSource, /renderChatMessages\(messages, \{ hideTrailingAssistant: state\.chatBusy, forceScroll: false \}\)/);
  assert.match(homeSource, /appendMessage\("user", message, \{ forceScroll: true \}\)/);
  assert.match(homeSource, /else el\.chatMessages\.scrollTop = previousScrollTop/);
  assert.match(assistantSource, /renderMessages\(data\.messages, \{ forceScroll: false \}\)/);
  assert.match(assistantSource, /renderMessages\(snapshot\.messages, \{ forceScroll: false \}\)/);
  assert.match(assistantSource, /scrollBottom\("auto", true\)/);
  assert.match(assistantSource, /else el\.messages\.scrollTop = previousScrollTop/);
});
