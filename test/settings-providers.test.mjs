import test from 'node:test';
import assert from 'node:assert/strict';
import { browserScenario, settingsTab } from './helpers/browser-scenario.mjs';

test('供应商常用优先、已配置可见、搜索自动展开更多与无匹配提示', {timeout:20000}, async t => {
  const scenario=await browserScenario(t,{configure:({state})=>{
    state.authProviders={oauthProviders:[
      {id:'rare-oauth',name:'Rare OAuth',loggedIn:false},
      {id:'configured-oauth',name:'Configured OAuth',loggedIn:true},
      {id:'openai-codex',name:'ChatGPT Plus/Pro',loggedIn:false},
    ],apiKeyProviders:[
      {id:'rare-api',name:'Rare API',configured:false},
      ...['openai','deepseek','kimi-coding'].map(id=>({id,name:id,configured:false})),
    ]};
  }});if(!scenario)return;
  const {browser,navigate}=scenario;await navigate();await settingsTab(browser,'accounts');
  const names=await browser.evaluate("[...oauthProviders.querySelectorAll('.provider-card b')].map(n=>n.textContent)");
  assert.deepEqual(new Set(names),new Set(['ChatGPT Plus/Pro','Configured OAuth']));
  assert.equal(await browser.evaluate("apiKeyProviders.querySelectorAll('.provider-card').length"),3);
  assert.equal(await browser.evaluate('moreProviders.open'),false);
  assert.ok(await browser.evaluate("providerSearch.getBoundingClientRect().height>=36&&moreProviders.querySelector('summary').getBoundingClientRect().height>=36&&parseFloat(getComputedStyle(providerSearch).paddingLeft)>=34"));
  const search=async value=>browser.evaluate(`providerSearch.value=${JSON.stringify(value)};providerSearch.dispatchEvent(new Event('input'))`);
  await search('rare-api');
  assert.equal(await browser.evaluate("moreProviders.open&&moreApiKeyProviders.textContent.includes('Rare API')"),true);
  await search('no-such-provider');
  assert.equal(await browser.evaluate("!providerSearchEmpty.classList.contains('hidden')"),true);
  await search('');
  assert.equal(await browser.evaluate("!moreProviders.open&&providerSearchEmpty.classList.contains('hidden')"),true);
  assert.deepEqual(browser.issues,[]);
});
