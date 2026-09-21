import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './helpers/browser-harness.mjs';

test('冷启动：Agent或工作区卡住不阻塞每日内容，刷新仍可读取，失败可重试', { timeout: 30000 }, async t => {
  if (!edgeAvailable()) return t.skip('未安装Microsoft Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  fixture.state.tasks = [{ id: 'task00000001', text: '冷启动事项', editableText: '冷启动事项', plannedDate: '2026-09-04', dueDate: null, completedDate: null, checked: false, headingPath: ['测试'], sourceLine: 1 }];
  fixture.state.dailyRecords = [{ id: '00000000-0000-4000-8000-000000000001', date: '2026-09-04', title: '冷启动记录', content: '测试正文', type: 'work', time: '', createdAt: '2026-09-04T00:00:00Z', updatedAt: '2026-09-04T00:00:00Z' }];
  browser = await launchBrowser({ width: 1600, height: 1000 });
  await browser.addInitScript(`const D=Date;window.Date=class extends D{constructor(...a){super(...(a.length?a:['2026-09-04T12:00:00+08:00']));}static now(){return new D('2026-09-04T12:00:00+08:00').getTime();}};
    window.dayReads=0;window.failedRead=false;const original=fetch;window.fetch=(...a)=>{const u=String(a[0]);
    if(u.includes('/api/day/')){dayReads++;if(location.search.includes('fail=1')&&!failedRead){failedRead=true;return Promise.resolve(new Response(JSON.stringify({error:'模拟首次读取失败'}),{status:503,headers:{'Content-Type':'application/json'}}));}}
    if(u.includes('/api/assistant/launch')){if(location.search.includes('reject=1'))return Promise.reject(new Error('模拟启动失败'));return new Promise(()=>{});}
    if(location.search.includes('workspace=1')&&u==='/api/workspaces')return new Promise(()=>{});
    return original(...a);};`);
  for (const query of ['?cold=1', '?cold=1&refresh=1', '?workspace=1', '?reject=1']) {
    await browser.navigate(`http://127.0.0.1:${fixture.port}/${query}`);
    await browser.waitFor("document.documentElement.classList.contains('app-ready') && dayTasks.querySelector('.task-card') && dailyRecordList.querySelector('.daily-record-card')");
    assert.equal(await browser.evaluate('dayReads'), 1);
    assert.ok(await browser.evaluate("dayTasks.textContent.includes('冷启动事项')"));
  }
  await browser.navigate(`http://127.0.0.1:${fixture.port}/?fail=1`);
  await browser.waitFor("dayTasks.textContent.includes('模拟首次读取失败')");
  await browser.evaluate('dayTasks.querySelector("button").click()');
  await browser.waitFor("dayTasks.querySelector('.task-card')");
  assert.equal(await browser.evaluate('dayReads'), 2);
});
