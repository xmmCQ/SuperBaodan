import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeAvailable, launchBrowser } from './helpers/browser-harness.mjs';
import { createSmokeServer } from './helpers/smoke-server.mjs';

test('持续空入口、新建/取消、日期选择、模式隔离和清空后保留', { timeout: 45000 }, async t => {
  if (!edgeAvailable()) return t.skip('未安装 Edge');
  const fixture = await createSmokeServer(); t.after(() => fixture.close());
  const browser = await launchBrowser({ width: 1440, height: 900 }); t.after(() => browser.close());
  await browser.navigate(`http://127.0.0.1:${fixture.port}/`);
  await browser.waitFor("document.documentElement.classList.contains('app-ready') && longtermCount.textContent === '0'");
  await browser.evaluate('todayButton.click()');
  await browser.waitFor("document.querySelector('.calendar-day.selected')?.dataset.date === '2026-09-04'");
  assert.equal(await browser.evaluate("!openLongtermTasks.classList.contains('hidden')"), true);
  await browser.evaluate('openLongtermTasks.click(); newLongtermTaskButton.click()');
  assert.equal(await browser.evaluate("!taskSummaryDialog.open && taskModalTitle.textContent === '新增持续工作' && taskStartDate.value === '' && taskEndDate.value === '' && taskRecurrence.value === '' && taskDailyDates.classList.contains('hidden')"), true);
  await browser.evaluate('taskStartDate.click()');
  assert.equal(await browser.evaluate("!taskDatePicker.classList.contains('hidden') && taskStartDate.value === ''"), true);
  await browser.evaluate("datePickerGrid.querySelector('[data-picker-date=\"2026-09-04\"]').click(); taskStartDate.click(); datePickerClear.click()");
  assert.equal(await browser.evaluate("taskStartDate.value === ''"), true);
  await browser.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await browser.waitFor('taskSummaryDialog.open');
  assert.equal(await browser.evaluate('document.activeElement === newLongtermTaskButton'), true);
  await browser.evaluate("newLongtermTaskButton.click(); taskText.value='无时间持续'; taskForm.requestSubmit()");
  await browser.waitFor("taskSummaryDialog.open && longtermCount.textContent === '1' && longtermTasks.innerText.includes('无时间持续')");
  assert.equal(fixture.state.tasks[0].kind, 'longterm'); assert.equal(fixture.state.tasks[0].recurrence, null);
  await browser.evaluate("longtermTasks.querySelector('[data-action=edit]').click(); taskStartDate.value='2026-09-04'; taskRecurrence.value='week'; taskForm.requestSubmit()");
  await browser.waitFor("taskSummaryDialog.open && longtermTasks.innerText.includes('起始 2026-09-04')");
  await browser.evaluate("closeTaskSummary.click(); dayTasks.querySelector('[data-action=edit]').click()");
  assert.equal(await browser.evaluate("taskModalTitle.textContent === '编辑持续工作' && taskStartDate.value === '2026-09-04'"), true);
  await browser.evaluate("taskStartDate.value=''; taskRecurrence.value=''; taskForm.requestSubmit()");
  await browser.waitFor("taskModal.classList.contains('hidden') && longtermCount.textContent === '1' && !dayTasks.querySelector('.task-card')");
  await browser.evaluate("newTaskButton.click(); taskRecurrence.value='year'");
  assert.equal(await browser.evaluate("taskDueDate.value === '2026-09-04' && taskRecurrenceField.classList.contains('hidden') && taskLongtermDates.classList.contains('hidden')"), true);
  await browser.evaluate("taskText.value='每日模式'; taskForm.requestSubmit()");
  await browser.waitFor("taskModal.classList.contains('hidden') && dayTasks.innerText.includes('每日模式')");
  assert.equal(fixture.state.tasks[1].kind, 'daily'); assert.equal(fixture.state.tasks[1].recurrence, undefined);
  await browser.evaluate("openLongtermTasks.click(); longtermTasks.querySelector('[data-action=toggle]').click()");
  await browser.waitFor("taskSummaryDialog.open && longtermCount.textContent === '0' && longtermTasks.innerText.includes('暂无持续工作')");
  assert.equal(await browser.evaluate("!openLongtermTasks.classList.contains('hidden') && !newLongtermTaskButton.classList.contains('hidden')"), true);
  for (let i = 0; i < 25; i++) fixture.state.tasks.push({ id: `scroll-${i}`, kind: 'longterm', text: `滚动事项${i}`, editableText: `滚动事项${i}`, checked: false, headingPath: ['持续工作'] });
  await browser.evaluate('closeTaskSummary.click(); refreshButton.click()');
  await browser.waitFor("longtermCount.textContent === '25'");
  await browser.evaluate('openLongtermTasks.click(); taskSummaryBody.scrollTop=180; newLongtermTaskButton.click(); closeTaskModal.click()');
  assert.equal(await browser.evaluate('taskSummaryDialog.open && taskSummaryBody.scrollTop === 180 && document.activeElement === newLongtermTaskButton'), true);
});

test('写入失败保留表单，已提交后刷新失败准确提示且连点只创建一次', { timeout: 40000 }, async t => {
  if (!edgeAvailable()) return t.skip('未安装 Edge');
  const fixture = await createSmokeServer(); t.after(() => fixture.close());
  const browser = await launchBrowser(); t.after(() => browser.close());
  await browser.addInitScript(`const nativeFetch=window.fetch; window.failureMode=''; window.createCalls=0;
    window.fetch=async (...args)=>{
      const url=String(args[0]);
      if(url.endsWith('/api/tasks') && args[1]?.method==='POST'){
        window.createCalls++;
        if(window.failureMode==='write') return new Response(JSON.stringify({error:'隔离写入失败'}), {status:500});
        await new Promise(r=>setTimeout(r,200));
      }
      if(url.includes('/api/dashboard') && window.failureMode==='refresh') return new Response(JSON.stringify({error:'隔离刷新失败'}), {status:500});
      return nativeFetch(...args);
    };`);
  await browser.navigate(`http://127.0.0.1:${fixture.port}/`);
  await browser.waitFor("document.documentElement.classList.contains('app-ready')");
  await browser.evaluate("openLongtermTasks.click(); newLongtermTaskButton.click(); taskText.value='不得重复'; taskStartDate.value='2026-09-02'; taskEndDate.value='2026-09-01'; taskForm.requestSubmit()");
  assert.equal(await browser.evaluate('window.createCalls'), 0);
  await browser.evaluate("taskStartDate.value=''; taskEndDate.value=''; window.failureMode='write'; taskForm.requestSubmit()");
  await browser.waitFor("!saveTaskButton.disabled && window.createCalls === 1");
  assert.equal(await browser.evaluate("!taskModal.classList.contains('hidden') && taskText.value === '不得重复'"), true);
  assert.equal(fixture.state.tasks.length, 0);
  await browser.evaluate("window.failureMode='refresh'; taskForm.requestSubmit(); taskForm.requestSubmit()");
  await browser.waitFor("taskSummaryDialog.open && taskSummaryNotice.textContent.includes('已保存，刷新失败')");
  assert.equal(fixture.state.tasks.length, 1); assert.equal(await browser.evaluate('window.createCalls'), 2);
  await browser.evaluate("window.failureMode=''; closeTaskSummary.click(); refreshButton.click()");
  await browser.waitFor("longtermCount.textContent === '1'");
});
