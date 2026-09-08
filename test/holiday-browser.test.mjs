import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeAvailable, launchBrowser } from './helpers/browser-harness.mjs';
import { createSmokeServer } from './helpers/smoke-server.mjs';

test('日历异步标休班不重建日期按钮，跨年缺数据提示且保留选择功能', { timeout: 20000 }, async (t) => {
  if (!edgeAvailable()) return t.skip('未安装Microsoft Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  fixture.state.holidays[2026] = { year: 2026, region: 'CN', status: 'available', dates: [
    { date: '2026-09-04', name: '测试放假', type: 'public_holiday' },
    { date: '2026-09-05', name: '测试补班', type: 'transfer_workday' },
    { date: '2026-12-31', name: '测试跨年', type: 'public_holiday' },
  ], stale: false, fetchedAt: '2026-09-04T00:00:00Z', warning: null };
  fixture.state.holidays[2027] = { year: 2027, region: 'CN', status: 'unavailable', dates: [], warning: '无数据' };
  browser = await launchBrowser({ width: 1600, height: 1000 });
  await browser.addInitScript(`const originalFetch=window.fetch; window.fetch=async(...args)=>{if(String(args[0]).includes('/api/holidays'))await new Promise(r=>setTimeout(r,1000));return originalFetch(...args);};`);
  await browser.navigate(`http://127.0.0.1:${fixture.port}/`);
  await browser.waitFor("document.documentElement.classList.contains('app-ready')");
  // Fixed fixture month, independent of the real system date.
  await browser.evaluate(`(()=>{const buttons=[...calendarGrid.querySelectorAll('[data-date]')];window.holidayButton=buttons[0];})()`);
  await browser.waitFor("!document.querySelector('.holiday-status').textContent.includes('加载中')");
  assert.equal(await browser.evaluate('window.holidayButton===calendarGrid.querySelector("[data-date]")'), true);
  // Use the calendar controller to render a deterministic month for these fixtures.
  await browser.evaluate(`(async()=>{window.holidayModule=await import('/home/calendar.js'); window.holidayState={month:'2026-09',today:'2026-09-04',selectedDate:'2026-09-04',dashboard:{events:[],pendingByDate:{}}};
    window.testCalendar=holidayModule.createCalendar({state:holidayState,elements:{calendarGrid,monthTitle},api:async url=>(await fetch(url)).json(),toLocalDate:d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'),formatChineseDate:d=>d,loadDay:d=>window.clickedHolidayDate=d});testCalendar.renderCalendar();})()`);
  await browser.waitFor("calendarGrid.querySelector('[data-date=\"2026-09-05\"] .holiday-badge')?.textContent==='班'");
  const marks = await browser.evaluate(`['2026-09-04','2026-09-05','2026-09-06','2026-09-07'].map(d=>calendarGrid.querySelector('[data-date="'+d+'"] .holiday-badge')?.textContent||'')`);
  assert.deepEqual(marks, ['休', '班', '休', '']);
  await browser.evaluate("calendarGrid.querySelector('[data-date=\"2026-09-05\"]').click()");
  assert.equal(await browser.evaluate('window.clickedHolidayDate'), '2026-09-05');
  assert.equal(await browser.evaluate("getComputedStyle(calendarGrid.querySelector('.holiday-badge')).pointerEvents"), 'none');
  await browser.evaluate("holidayState.month='2026-12';testCalendar.renderCalendar()");
  await browser.waitFor("document.body.textContent.includes('2027年数据不可用')");
  assert.equal(await browser.evaluate("calendarGrid.querySelector('[data-date=\"2027-01-02\"] .holiday-badge')"), null);
  assert.equal(await browser.evaluate("calendarGrid.querySelector('[data-date=\"2026-12-31\"] .holiday-badge').textContent"), '休');
  assert.deepEqual(browser.issues, []);
});
