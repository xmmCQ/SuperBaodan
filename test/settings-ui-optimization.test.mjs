import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthController } from '../app/renderer/assistant/auth-controller.js';

// Search/grouping and hit areas are exercised by settings-providers,
// task-card-layout and ui-unification, not by matching JS or CSS source spelling.
test('供应商卡片展示账号状态，不依赖旧模型数量字段', t => {
  const original = globalThis.document;
  t.after(() => { globalThis.document = original; });
  const node = () => ({ children: [], textContent: '', append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, addEventListener() {} });
  const text = n => n.textContent + n.children.map(text).join('');
  globalThis.document = { createElement: node };
  const controller = createAuthController({ state: {}, elements: {}, invoke: async () => ({}) });
  for (const [type, provider, expected] of [
    ['oauth', { id: 'openai-codex', name: 'ChatGPT', loggedIn: true }, '已登录'],
    ['oauth', { id: 'openai-codex', name: 'ChatGPT', loggedIn: false }, '未登录'],
    ['api-key', { id: 'openai', name: 'OpenAI', configured: true }, '已设置'],
    ['api-key', { id: 'openai', name: 'OpenAI', configured: false }, '未设置'],
  ]) {
    const container = node(); controller.renderProviderCards(container, [provider], type);
    assert.ok(text(container).includes(expected));
  }
});
