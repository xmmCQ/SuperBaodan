import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthController } from '../app/renderer/assistant/auth-controller.js';
class Element {
  constructor() { this.children = []; this.listeners = {}; this.classList = { add() {}, remove() {} }; }
  append(...items) { this.children.push(...items); }
  replaceChildren() { this.children = []; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
}
function fixture(t) {
  const original = { window: globalThis.window, document: globalThis.document };
  t.after(() => Object.assign(globalThis, original));
  const opened = [], calls = [], errors = [], listeners = new Set();
  globalThis.document = { createElement: () => new Element() };
  globalThis.window = { workbench: { openExternal: async url => opened.push(url), onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); } } };
  const progress = new Element();
  const controller = createAuthController({
    state: {}, elements: { loginProgress: progress }, invoke: async (name, args) => { calls.push({ name, args }); return {}; },
    showError: e => errors.push(e), showNotice() {}, showSettingsToast() {}, loadBootstrap() {}, loadModelCatalog() {},
  });
  return { controller, progress, opened, calls, errors, emit: event => { for (const fn of listeners) fn({ topic: 'auth', event }); } };
}
test('登录选择只提交参数，收到授权事件再打开外部浏览器', async t => {
  const f = fixture(t);
  f.controller.renderLoginInputControls('openai-codex', 'token', '', [{ id: 'browser', label: 'Browser' }]);
  await f.progress.children[0].children[0].listeners.click();
  assert.equal(f.calls[0].name, 'auth.input'); assert.deepEqual(f.opened, []);
  f.controller.renderOAuthAction({ id: 'openai-codex', name: 'ChatGPT' }, { url: 'https://example.com/auth' });
  assert.deepEqual(f.opened, ['https://example.com/auth']);
});
test('登录订阅按ID隔离，切换账号后旧事件不会打开浏览器', t => {
  const f = fixture(t);
  f.controller.startOAuthLogin({ id: 'anthropic', name: 'Anthropic' });
  const first = f.calls.find(c => c.name === 'auth.start').args.subscriptionId;
  f.controller.startOAuthLogin({ id: 'xai', name: 'xAI' });
  const second = f.calls.filter(c => c.name === 'auth.start').at(-1).args.subscriptionId;
  f.emit({ subscriptionId: first, type: 'auth', url: 'https://example.com/old' });
  f.emit({ subscriptionId: second, type: 'device_code', verificationUri: 'https://example.com/new', userCode: 'CODE' });
  assert.deepEqual(f.opened, ['https://example.com/new']);
  f.controller.closeActiveLogin();
  assert.equal(f.calls.at(-1).name, 'auth.cancel');
});
test('外链接口缺失时保留手动授权链接', t => {
  const f = fixture(t); delete window.workbench.openExternal;
  f.controller.renderOAuthAction({ id: 'test', name: 'Test' }, { url: 'https://example.com/auth' });
  assert.equal(f.progress.children[1].href, 'https://example.com/auth');
  assert.equal(f.progress.children[1].textContent, '打开授权页面');
});
