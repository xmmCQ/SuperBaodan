import test from 'node:test';
import assert from 'node:assert/strict';
import { HOLIDAY_CACHE_KEY, readHolidayCache, writeHolidayCache, validHolidaySnapshot } from '../public/home/holiday-cache.js';
import { edgeAvailable, launchBrowser } from './helpers/browser-harness.mjs';
import { createSmokeServer } from './helpers/smoke-server.mjs';
const snapshot = (year = 2026) => ({ year, region: 'CN', status: 'available', fetchedAt: new Date().toISOString(), dates: [{ date: `${year}-09-05`, name: '测试日期', type: 'public_holiday' }] });
const storage = () => { const map = new Map(); return { getItem: k => map.get(k) || null, setItem: (k,v) => map.set(k,v) }; };

test('浏览器缓存校验、按年隔离、损坏/禁用降级、不覆盖新数据及容量上限', () => {
  const store = storage(), data = snapshot();
  assert.equal(writeHolidayCache(data, store), true);
  assert.equal(readHolidayCache(2026, store).dates[0].type, 'public_holiday');
  assert.equal(readHolidayCache(2025, store), null);
  const old = { ...data, fetchedAt: '2020-01-01T00:00:00Z', dates: [{ ...data.dates[0], type: 'transfer_workday' }] };
  writeHolidayCache(old, store); assert.equal(readHolidayCache(2026, store).dates[0].type, 'public_holiday');
  assert.equal(writeHolidayCache({ ...data, status: 'unavailable' }, store), false);
  for (const bad of [{ ...data, dates: [] }, { ...data, region: 'JP' }, { ...data, fetchedAt: 'bad' }, { ...data, dates: [data.dates[0], data.dates[0]] }, { ...data, dates: [{ ...data.dates[0], date: '2026-02-30' }] }]) assert.equal(validHolidaySnapshot(bad, 2026), false);
  store.setItem(HOLIDAY_CACHE_KEY, '{bad'); assert.equal(readHolidayCache(2026, store), null);
  writeHolidayCache(old, store); assert.equal(readHolidayCache(2026, store).stale, true);
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } };
  assert.equal(readHolidayCache(2026, blocked), null); assert.equal(writeHolidayCache(data, blocked), false);
  for (let year = 2000; year < 2015; year++) writeHolidayCache(snapshot(year), store);
  assert.equal(JSON.parse(store.getItem(HOLIDAY_CACHE_KEY)).years.length, 12);
});

test('刷新后同步显示浏览器缓存，后台成功替换，失败或无数据保留标识', { timeout: 20000 }, async t => {
  if (!edgeAvailable()) return t.skip('未安装Microsoft Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await launchBrowser({ width: 1600, height: 1000 });
  await browser.addInitScript(`const original=window.fetch;window.fetch=(...args)=>String(args[0]).includes('/api/holidays')?new Promise(()=>{}):original(...args);`);
  const url = `http://127.0.0.1:${fixture.port}/`;
  const open = async () => { await browser.navigate(url); await browser.waitFor("document.documentElement.classList.contains('app-ready')"); };
  const mount = () => browser.evaluate(`(async()=>{
    const {createHolidayMarks}=await import('/home/holiday-marks.js');
    const section=document.createElement('section');document.body.append(section);
    const grid=document.createElement('div');section.append(grid);grid.innerHTML='<button data-date="2026-09-05" aria-label="测试日期"></button>';
    window.cacheGrid=grid;window.cacheButton=grid.firstElementChild;window.cacheSection=section;
    const marks=createHolidayMarks({container:grid,api:()=>new Promise((resolve,reject)=>{window.resolveHoliday=resolve;window.rejectHoliday=reject;})});marks.refresh();
    return grid.querySelector('.holiday-badge')?.textContent||'';
  })()`);
  await open(); assert.equal(await mount(), '');
  const first = snapshot();
  await browser.evaluate(`window.resolveHoliday(${JSON.stringify(first)})`);
  await browser.waitFor("cacheGrid.querySelector('.holiday-badge')?.textContent==='休'");
  await open(); assert.equal(await mount(), '休'); // Before the API promise resolves.
  const next = { ...first, fetchedAt: new Date().toISOString(), dates: [{ ...first.dates[0], type: 'transfer_workday' }] };
  await browser.evaluate(`window.resolveHoliday(${JSON.stringify(next)})`);
  await browser.waitFor("cacheGrid.querySelector('.holiday-badge')?.textContent==='班'");
  assert.equal(await browser.evaluate('cacheGrid.firstElementChild===cacheButton'), true);
  await open(); assert.equal(await mount(), '班');
  await browser.evaluate("window.rejectHoliday(new Error('offline'))");
  await browser.waitFor("cacheSection.textContent.includes('更新失败')");
  assert.equal(await browser.evaluate("cacheGrid.querySelector('.holiday-badge').textContent"), '班');
  assert.equal(await mount(), '班');
  await browser.evaluate("window.resolveHoliday({year:2026,region:'CN',status:'unavailable',dates:[]})");
  await browser.waitFor("cacheSection.textContent.includes('更新失败')");
  assert.equal(await browser.evaluate("cacheGrid.querySelector('.holiday-badge').textContent"), '班');
  assert.deepEqual(browser.issues, []);
});
