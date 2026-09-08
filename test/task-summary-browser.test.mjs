import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeAvailable, launchBrowser } from './helpers/browser-harness.mjs';
import { createSmokeServer } from './helpers/smoke-server.mjs';

test('日历工作提示和轻弹窗使用隔离数据', { timeout: 40000 }, async (t) => {
  if (!edgeAvailable()) return t.skip('未安装 Edge');
  const fixture = await createSmokeServer();
  t.after(() => fixture.close());
  const browser = await launchBrowser({ width: 1440, height: 900 });
  t.after(() => browser.close());
  fixture.state.tasks.push({ id: 'summary', text: '持续测试', editableText: '持续测试', recurrence: 'week', checked: false, roles: [], headingPath: ['测试'] });
  await browser.addInitScript(`
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]).includes('/api/dashboard') && window.summaryScenario) {
        const data = await response.json();
        const task = { id: 'overdue-fixture', text: '遗留测试', editableText: '遗留测试', overdueDays: 2, anchorDate: '2026-09-02', checked: false };
        data.overdue = window.summaryScenario.includes('overdue') ? [task] : [];
        if (!window.summaryScenario.includes('longterm')) data.longTerm = [];
        return new Response(JSON.stringify(data), { status: 200, headers: {'Content-Type':'application/json'} });
      }
      return response;
    };
  `);
  await browser.navigate(`http://127.0.0.1:${fixture.port}/`);
  await browser.waitFor("document.documentElement.classList.contains('app-ready') && longtermCount.textContent === '1'");
  assert.equal(await browser.evaluate("openOverdueTasks.classList.contains('hidden') && !openLongtermTasks.classList.contains('hidden') && !document.querySelector('.summary-cards')"), true);
  await browser.evaluate('openLongtermTasks.click()');
  assert.equal(await browser.evaluate("taskSummaryDialog.open && taskSummaryTitle.textContent === '持续工作 · 1 项'"), true);
  assert.equal(await browser.evaluate("(() => { const r=taskSummaryDialog.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()"), true);
  await browser.evaluate("longtermTasks.querySelector('[data-action=edit]').click()");
  await browser.waitFor("!taskSummaryDialog.open && !taskModal.classList.contains('hidden')");
  await browser.evaluate('cancelTaskButton.click()');
  await browser.waitFor('taskSummaryDialog.open');
  await browser.evaluate("longtermTasks.querySelector('[data-action=edit]').click(); taskRecurrence.value=''; taskDueDate.value='2026-09-04'; taskForm.requestSubmit()");
  await browser.waitFor("taskSummaryDialog.open && openLongtermTasks.classList.contains('hidden') && longtermTasks.innerText.includes('暂无持续工作')");
  await browser.evaluate('closeTaskSummary.click()');
  assert.equal(await browser.evaluate('document.activeElement === todayButton'), true);
  fixture.state.tasks[0].recurrence = 'week';
  for (const [scenario, overdue, longterm] of [['overdue-longterm', 1, 1], ['overdue', 1, 0], ['longterm', 0, 1], ['none', 0, 0]]) {
    await browser.evaluate(`window.summaryScenario=${JSON.stringify(scenario)}; refreshButton.click()`);
    await browser.waitFor(`overdueCount.textContent === '${overdue}' && longtermCount.textContent === '${longterm}'`);
    assert.equal(await browser.evaluate(`taskSummaryHints.classList.contains('hidden')`), overdue + longterm === 0);
  }
  await browser.evaluate("window.summaryScenario='overdue'; refreshButton.click()");
  await browser.waitFor("overdueCount.textContent === '1'");
  await browser.evaluate('openOverdueTasks.click()');
  assert.equal(await browser.evaluate("Boolean(overdueTasks.querySelector('[data-action=delete]'))"), false);
  await browser.evaluate("taskSummaryDialog.dispatchEvent(new Event('cancel', {cancelable:true}))");
  assert.equal(await browser.evaluate('!taskSummaryDialog.open && document.activeElement === openOverdueTasks'), true);
  await browser.evaluate("window.summaryScenario=null; refreshButton.click()");
  await browser.waitFor("longtermCount.textContent === '1'");
  await browser.evaluate("openLongtermTasks.click(); longtermTasks.querySelector('[data-action=delete]').click()");
  await browser.waitFor("taskSummaryDialog.open && longtermTasks.innerText.includes('暂无持续工作') && taskSummaryHints.classList.contains('hidden')");
  assert.equal(fixture.state.tasks.length, 0);
  assert.ok(fixture.state.operations.includes('task:delete'));
});
