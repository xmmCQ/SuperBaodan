import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/assistant.html", import.meta.url), "utf8");
const auth = await readFile(new URL("../public/assistant/auth-controller.js", import.meta.url), "utf8");
const sessions = await readFile(new URL("../public/assistant/sessions-view.js", import.meta.url), "utf8");
const assistantCss = await readFile(new URL("../public/assistant.css", import.meta.url), "utf8");
const homeCss = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const iconCss = await readFile(new URL("../public/icon-actions.css", import.meta.url), "utf8");

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
  assert.match(auth, /provider\.modelCount \|\| 0/);
  assert.match(auth, /configured \? "已登录" : "未登录"/);
  assert.match(auth, /configured \? "已设置" : "未设置"/);
  assert.match(assistantCss, /\.provider-search-row input \{[\s\S]*min-height: 40px/);
  assert.match(assistantCss, /\.provider-more summary \{[\s\S]*min-height: 44px/);
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
