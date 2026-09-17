import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAuthController } from '../app/renderer/assistant/auth-controller.js';

const html = await readFile(new URL("../app/renderer/assistant.html", import.meta.url), "utf8");
const auth = await readFile(new URL("../app/renderer/assistant/auth-controller.js", import.meta.url), "utf8");
const sessions = await readFile(new URL("../app/renderer/assistant/sessions-view.js", import.meta.url), "utf8");
const assistantCss = await readFile(new URL("../app/renderer/assistant.css", import.meta.url), "utf8");
const homeCss = await readFile(new URL("../app/renderer/styles.css", import.meta.url), "utf8");
const iconCss = await readFile(new URL("../app/renderer/icon-actions.css", import.meta.url), "utf8");

test("模型配置支持供应商搜索、常用优先和更多供应商折叠", () => {
  for (const id of [
    "providerSearch", "oauthProviderGroup", "oauthProviders", "apiKeyProviderGroup", "apiKeyProviders",
    "moreProviders", "moreProviderCount", "moreOauthGroup", "moreOauthProviders",
    "moreApiKeyGroup", "moreApiKeyProviders", "providerSearchEmpty",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<h3>OAuth供应商<\/h3>/);
  assert.match(html, /<h3>API Key供应商<\/h3>/);
  assert.match(html, /<summary>更多供应商/);
  assert.match(auth, /oauth: \["openai-codex"\]/);
  assert.match(auth, /"api-key": \["openai", "deepseek", "kimi-coding"\]/);
  assert.match(auth, /providerConfigured\(provider, "oauth"\) \|\| providerIsCommon/);
  assert.match(auth, /providerConfigured\(provider, "api-key"\) \|\| providerIsCommon/);
  assert.match(auth, /el\.moreProviders\.open = Boolean\(query && moreCount\)/);
  assert.match(auth, /configured \? "已登录" : "未登录"/);
  assert.match(auth, /configured \? "已设置" : "未设置"/);
  assert.match(assistantCss, /\.provider-search-row input \{[\s\S]*min-height: 40px/);
  assert.match(assistantCss, /\.provider-more summary \{[\s\S]*min-height: 44px/);
});

test('供应商卡片展示账号状态，不依赖旧模型数量字段', t => {
  const original = globalThis.document;
  t.after(() => { globalThis.document = original; });
  const node = () => ({ children: [], textContent: '', append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, addEventListener() {} });
  globalThis.document = { createElement: node };
  const controller = createAuthController({ state: {}, elements: {}, invoke: async () => ({}) });
  for (const [type, provider, expected] of [
    ['oauth', { id: 'openai-codex', name: 'ChatGPT', loggedIn: true }, '已登录'],
    ['oauth', { id: 'openai-codex', name: 'ChatGPT', loggedIn: false }, '未登录'],
    ['api-key', { id: 'openai', name: 'OpenAI', configured: true }, '已设置'],
    ['api-key', { id: 'openai', name: 'OpenAI', configured: false }, '未设置'],
  ]) {
    const container = node(); controller.renderProviderCards(container, [provider], type);
    assert.equal(container.children[0].children[0].children[1].textContent, expected);
  }
});

test("重点小按钮满足最小热区并保留小图标", () => {
  assert.match(homeCss, /\.task-check \{ width: 32px; height: 32px;/);
  assert.match(homeCss, /\.task-edit, \.task-delete \{ min-width: 32px; min-height: 32px;/);
  assert.match(sessions, /renameButton\.className = "icon-action icon-accent tooltip-left"/);
  assert.match(sessions, /icons\.svg#pencil/);
  assert.match(sessions, /remove\.className = "icon-action icon-danger tooltip-left"/);
  assert.match(sessions, /icons\.svg#trash-2/);
  assert.doesNotMatch(sessions, /textContent = "(?:✎|×)"/);
  assert.match(iconCss, /width: 36px !important;/);
  assert.match(iconCss, /height: 36px !important;/);
  assert.match(iconCss, /\.icon-action svg \{ width: 18px; height: 18px;/);
});
