import test from 'node:test';
import assert from 'node:assert/strict';
import { taskOrderKey, orderedKeys, moveOrder } from '../public/home/card-order.js';
import { edgeAvailable, launchBrowser } from './helpers/browser-harness.mjs';
import { createSmokeServer } from './helpers/smoke-server.mjs';

test('排序身份不依赖待办行号、完成状态或日期，新卡片追加而非覆盖旧排序', () => {
  const task = { text: '整理资料', headingPath: ['项目'], parentTasks: [], sourceLine: 1, id: 'old' };
  assert.equal(taskOrderKey(task), taskOrderKey({ ...task, id: 'new', sourceLine: 99, checked: true, completedDate: '2026-09-04' }));
  assert.notEqual(taskOrderKey(task), taskOrderKey({ ...task, text: '另一件事' }));
  assert.deepEqual(orderedKeys(['new', 'a', 'b'], ['gone', 'b', 'a']), ['b', 'a', 'new']);
  assert.deepEqual(moveOrder(['a', 'b', 'c'], 'c', 'a', false), ['c', 'a', 'b']);
  assert.deepEqual(moveOrder(['a', 'b', 'c'], 'a', 'c', true), ['b', 'c', 'a']);
});
const paint = (browser) => browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');

test('两类当日卡片可排序并记忆，日期隔离，不改源数据或破坏日历改期', { timeout: 35000 }, async (t) => {
  if (!edgeAvailable()) return t.skip('未安装Microsoft Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  fixture.state.tasks = ['A', 'B', 'C', 'A', 'B', 'C'].map((letter, i) => ({ id: `task${String(i + 1).padStart(8, '0')}`, text: `工作${letter}`, editableText: `工作${letter}`, plannedDate: i < 3 ? '2026-09-04' : '2026-09-05', dueDate: null, completedDate: null, checked: false, headingPath: ['测试'], parentTasks: [], sourceLine: i + 1 }));
  fixture.state.dailyRecords = ['A', 'B', 'C'].map((letter, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, date: '2026-09-04', title: `记录${letter}`, type: 'work', time: `${10+i}:00`, content: `记录${letter}的正文`, createdAt: '2026-09-04T08:00:00.000Z', updatedAt: '2026-09-04T08:00:00.000Z' }));
  const original = structuredClone({ tasks: fixture.state.tasks, records: fixture.state.dailyRecords });
  browser = await launchBrowser({ width: 1600, height: 1000 });
  const url = `http://127.0.0.1:${fixture.port}/`;
  const openDay = async () => {
    await browser.navigate(url); await browser.waitFor("document.documentElement.classList.contains('app-ready')");
    await browser.evaluate("calendarGrid.querySelector('[data-date=\"2026-09-04\"]').click()");
    await browser.waitFor('dayTasks.children.length===3');
  };
  await openDay();
  const titles = (records = false) => browser.evaluate(records ? "[...dailyRecordList.querySelectorAll('.daily-record-main strong')].map(n=>n.textContent)" : "[...dayTasks.querySelectorAll('.task-card-title')].map(n=>n.textContent)");
  const drag = (list, from, to) => browser.evaluate(`(()=>{
    const cards=[...document.getElementById('${list}').children], source=cards[${from}], target=cards[${to}], handle=source, dt=new DataTransfer(), box=target.getBoundingClientRect();
    handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
    handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));
    target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:box.top+2}));
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:box.top+2}));
    handle.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));
  })()`);
  assert.equal(await browser.evaluate("dayTasks.querySelectorAll('[data-card-order-handle]').length"), 0);
  assert.equal(await browser.evaluate(`(()=>{const button=dayTasks.querySelector('[data-action=edit]'), card=button.closest('.task-card');button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));const e=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()});card.dispatchEvent(e);return e.defaultPrevented;})()`), true);
  await browser.evaluate("delete dayTasks.children[2].dataset.moveKind"); // A card without a movable date can still sort.
  await drag('dayTasks', 2, 0);
  assert.deepEqual(await titles(), ['工作C', '工作A', '工作B']);
  assert.equal(await browser.evaluate("calendarGrid.classList.contains('drag-active')"), false);
  await browser.evaluate('dailyRecordsTab.click()');
  await browser.waitFor('dailyRecordList.children.length===3');
  await drag('dailyRecordList', 2, 0);
  assert.deepEqual(await titles(true), ['记录C', '记录A', '记录B']);
  assert.deepEqual({ tasks: fixture.state.tasks, records: fixture.state.dailyRecords }, original);
  await browser.evaluate("dailyRecordList.querySelector('[data-record-action=toggle]').click()");
  assert.equal(await browser.evaluate("dailyRecordList.firstElementChild.classList.contains('expanded')"), true);
  assert.deepEqual(await titles(true), ['记录C', '记录A', '记录B']);
  await openDay();
  assert.deepEqual(await titles(), ['工作C', '工作A', '工作B']);
  await browser.evaluate('dailyRecordsTab.click()'); await browser.waitFor('dailyRecordList.children.length===3');
  assert.deepEqual(await titles(true), ['记录C', '记录A', '记录B']);
  await browser.evaluate("dailyRecordSearch.value='记录';dailyRecordSearch.dispatchEvent(new Event('input',{bubbles:true}))");
  await browser.waitFor("!dailyRecordSearchStatus.classList.contains('hidden') && dailyRecordList.querySelector('[data-record-action=locate]')");
  assert.equal(await browser.evaluate("dailyRecordList.querySelectorAll('[draggable=true]').length"), 0);
  await browser.evaluate('clearDailyRecordSearch.click()'); await paint(browser);
  assert.deepEqual(await titles(true), ['记录C', '记录A', '记录B']);
  await browser.evaluate("dayTasksTab.click(); calendarGrid.querySelector('[data-date=\"2026-09-05\"]').click()");
  await browser.waitFor("dayTasks.querySelector('[data-task-id=\"task00000004\"]')");
  assert.deepEqual(await titles(), ['工作A', '工作B', '工作C']);
  await browser.evaluate("calendarGrid.querySelector('[data-date=\"2026-09-04\"]').click()");
  await browser.waitFor("dayTasks.querySelector('[data-task-id=\"task00000001\"]')");
  assert.deepEqual(await titles(), ['工作C', '工作A', '工作B']);
  await browser.evaluate("dayTasks.querySelector('[data-task-id=\"task00000001\"] [data-action=edit]').click();taskText.value='工作A改名';taskForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
  await browser.waitFor("taskModal.classList.contains('hidden') && dayTasks.textContent.includes('工作A改名')");
  assert.deepEqual(await titles(), ['工作C', '工作A改名', '工作B']);
  await browser.evaluate("dayTasks.firstElementChild.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true,cancelable:true}))");
  assert.deepEqual(await titles(), ['工作A改名', '工作C', '工作B']);
  // The same whole-card drag can instead end on a calendar date.
  await browser.evaluate(`(()=>{const source=dayTasks.querySelector('[data-task-id="task00000002"]'), target=calendarGrid.querySelector('[data-date="2026-09-05"]'), dt=new DataTransfer();source.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));})()`);
  await browser.waitFor("selectedDateTitle.textContent.includes('5') && dayTasks.querySelector('[data-task-id=\"task00000002\"]')");
  assert.equal(fixture.state.tasks[1].plannedDate, '2026-09-05');
  assert.deepEqual(browser.issues, []);
});
