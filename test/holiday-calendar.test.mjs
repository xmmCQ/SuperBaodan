import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTempProject } from './helpers/temp-project.mjs';
import { createHolidayCalendar, validateHolidayData, holidaySources } from '../lib/holiday-calendar.mjs';
import { holidayInfo } from '../public/home/holiday-marks.js';
import { createServerApplication } from '../server/app.mjs';

const data = { region: 'CN', year: 2026, dates: [
  { date: '2026-09-04', name_cn: '测试放假', type: 'public_holiday' },
  { date: '2026-09-05', name_cn: '测试补班', type: 'transfer_workday' },
] };
const response = (value = data) => new Response(JSON.stringify(value));
async function setup(t) { const temp = await createTempProject('holiday-test-'); t.after(() => temp.cleanup()); return temp.root; }

test('放假覆盖普通工作日、补班覆盖周末；无数据不猜测休班', () => {
  const valid = { ...validateHolidayData(data, 2026), status: 'available' };
  assert.equal(holidayInfo('2026-09-04', valid).mark, '休');
  assert.equal(holidayInfo('2026-09-05', valid).mark, '班');
  assert.equal(holidayInfo('2026-09-06', valid).mark, '休');
  assert.equal(holidayInfo('2026-09-07', valid).mark, '');
  assert.equal(holidayInfo('2026-09-06', { status: 'unavailable' }).mark, '');
  for (const invalid of [{ ...data, year: 2025 }, { ...data, region: 'JP' }, { ...data, dates: [] }, { ...data, dates: [data.dates[0], data.dates[0]] }, { ...data, dates: [{ ...data.dates[0], date: '2026-02-30' }] }, { ...data, dates: [{ ...data.dates[0], type: 'unknown' }] }]) assert.throws(() => validateHolidayData(invalid, 2026));
});
test('并发请求合并、CDN失败切换、持久缓存离线可用', async (t) => {
  const root = await setup(t); let calls = 0;
  const service = createHolidayCalendar({ cacheDir: root, fetchImpl: async () => { calls++; if (calls === 1) return new Response('error', { status: 503 }); return response(); } });
  const results = await Promise.all([service.get(2026), service.get(2026), service.get(2026)]);
  assert.equal(calls, 2); assert.ok(results.every((r) => r.status === 'available'));
  assert.equal(results[0].source, holidaySources(2026)[1]);
  const offline = createHolidayCalendar({ cacheDir: root, fetchImpl: async () => { throw new Error('Should not fetch fresh cache'); } });
  assert.equal((await offline.get(2026)).status, 'available');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '2026.json'), 'utf8')).dates, results[0].dates);
});
test('过期缓存立即返回，更新失败不覆盖旧数据且冷却重试', async (t) => {
  const root = await setup(t); let time = Date.parse('2026-09-04T00:00:00Z'), failing = false, calls = 0;
  const service = createHolidayCalendar({ cacheDir: root, now: () => time, fetchImpl: async () => { calls++; if (failing) throw new Error('offline'); return response(); } });
  await service.get(2026); const original = await fs.readFile(path.join(root, '2026.json'), 'utf8');
  time += 2 * 86400000; failing = true;
  assert.equal((await service.get(2026)).stale, true);
  await new Promise(setImmediate);
  const result = await service.get(2026);
  assert.equal(result.status, 'available'); assert.match(result.warning, /更新失败/); assert.equal(calls, 3);
  assert.equal(await fs.readFile(path.join(root, '2026.json'), 'utf8'), original);
});
test('节假日API读取隔离缓存并校验年份和本机来源', async (t) => {
  const root = await setup(t);
  await fs.writeFile(path.join(root, '2026.json'), JSON.stringify({ ...data, fetchedAt: new Date().toISOString(), source: holidaySources(2026)[0] }));
  const context = { config: { host: '127.0.0.1', port: 0, holidayCacheDir: root, publicDir: path.resolve('public') }, attachServer() {} };
  const server = createServerApplication(context);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.config.port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${context.config.port}/api/holidays`;
  const result = await fetch(`${base}?year=2026`);
  assert.equal(result.status, 200); assert.equal((await result.json()).status, 'available');
  assert.equal((await fetch(`${base}?year=../2026`)).status, 400);
  assert.equal((await fetch(`${base}?year=2026`, { headers: { Origin: 'https://example.invalid' } })).status, 403);
});

test('读取正文超时切换来源，缓存保存失败仍可使用已获取数据', async (t) => {
  const root = await setup(t); let calls = 0;
  const keepAlive = setInterval(() => {}, 100); t.after(() => clearInterval(keepAlive));
  const hanging = createHolidayCalendar({ cacheDir: root, timeoutMs: 20, fetchImpl: async (_url, { signal }) => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { signal.addEventListener('abort', () => controller.error(new Error('timeout')), { once: true }); } }));
  } });
  assert.equal((await hanging.get(2026)).status, 'unavailable'); assert.equal(calls, 2);
  const file = path.join(root, 'not-a-directory'); await fs.writeFile(file, 'keep');
  const unwritable = createHolidayCalendar({ cacheDir: file, fetchImpl: async () => response() });
  const result = await unwritable.get(2026);
  assert.equal(result.status, 'available'); assert.match(result.warning, /缓存保存失败/);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});

test('损坏缓存、空数据、非法年份、过大响应均安全降级', async (t) => {
  const root = await setup(t); await fs.writeFile(path.join(root, '2026.json'), 'broken');
  let calls = 0;
  const service = createHolidayCalendar({ cacheDir: root, fetchImpl: async () => { calls++; return response({ ...data, dates: [] }); } });
  assert.equal((await service.get(2026)).status, 'unavailable');
  assert.equal((await service.get(2026)).status, 'unavailable'); assert.equal(calls, 2);
  await assert.rejects(service.get('../2026'), { statusCode: 400 });
  const huge = createHolidayCalendar({ cacheDir: root, fetchImpl: async () => new Response(' '.repeat(300000)) });
  assert.equal((await huge.get(2026)).status, 'unavailable');
});
