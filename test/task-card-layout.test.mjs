import test from 'node:test';
import assert from 'node:assert/strict';
import { browserScenario, paint } from './helpers/browser-scenario.mjs';

// CRUD is covered by browser-smoke; drag-button isolation by card-order.
test('当日任务卡片首屏容纳、日期成项、图标热区和日历字号', {timeout:25000}, async t=>{
  const scenario=await browserScenario(t,{width:1280,height:720,configure:({state})=>{
    state.tasks=['核对清单','整理资料','确认进度'].map((text,i)=>({id:'detail-'+i,kind:'daily',text,editableText:text,checked:false,plannedDate:'2026-09-04',dueDate:'2026-09-04',headingPath:['工作待办'],sourceLine:i+1}));
  }});if(!scenario)return;
  const {browser,navigate,shot}=scenario;await navigate('/');
  await browser.evaluate("calendarGrid.querySelector('[data-date=\"2026-09-04\"]').click()");
  await browser.waitFor("dayTasks.querySelectorAll('.task-card').length===3");await paint(browser);
  const metrics=await browser.evaluate(`(()=>{const cards=[...dayTasks.querySelectorAll('.task-card')],last=cards.at(-1).getBoundingClientRect(),box=dayTasks.getBoundingClientRect();return {fit:last.bottom<=box.bottom+1,font:getComputedStyle(document.querySelector('.day-number')).fontSize,dates:[...dayTasks.querySelectorAll('.task-date-item')].map(e=>[e.textContent.trim(),getComputedStyle(e).whiteSpace]),buttons:cards.every(c=>{const title=c.querySelector('.task-card-title').getBoundingClientRect(),edit=c.querySelector('.task-edit').getBoundingClientRect(),check=c.querySelector('.task-check').getBoundingClientRect();return check.width>=32&&check.height>=32&&title.right<=edit.left&&[...c.querySelectorAll('.task-card-actions button')].every(b=>b.getBoundingClientRect().width>=32&&b.getBoundingClientRect().height>=32&&b.querySelector('svg'))})}})()`);
  assert.equal(metrics.fit,true,JSON.stringify(metrics));assert.equal(metrics.font,'14px');assert.equal(metrics.buttons,true);
  assert.equal(metrics.dates.length,6);
  for(const [text,space] of metrics.dates){assert.match(text,/(计划|截止).*2026-09-04/);assert.equal(space,'nowrap');}
  await shot('home-task-cards');
  await browser.setViewport(1920,1080);await paint(browser);
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.day-number')).fontSize"),'14px');
  assert.ok(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'));
  assert.deepEqual(browser.issues,[]);
});
