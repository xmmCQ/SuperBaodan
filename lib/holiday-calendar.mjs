import fs from 'node:fs/promises';
import path from 'node:path';

export const holidaySources = (year) => [
  `https://gcore.jsdelivr.net/gh/cg-zhou/holiday-calendar@main/data/CN/${year}.json`,
  `https://unpkg.com/holiday-calendar/data/CN/${year}.json`,
];
const DAY = 86400000, LIMIT = 256 * 1024;
export function validateHolidayData(data, year) {
  if (data?.region !== 'CN' || data.year !== year || !Array.isArray(data.dates) || !data.dates.length || data.dates.length > 366) throw new Error('Invalid holiday document');
  const seen = new Set();
  const dates = data.dates.map((item) => {
    const date = item?.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(`${year}-`) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || seen.has(date)) throw new Error('Invalid holiday date');
    if (!['public_holiday', 'transfer_workday'].includes(item.type)) throw new Error('Invalid holiday type');
    const name = item.name_cn || item.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error('Invalid holiday name');
    seen.add(date); return { date, type: item.type, name: name.trim() };
  });
  return { year, region: 'CN', dates };
}
async function boundedJson(response) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > LIMIT) throw new Error('Response too large'); chunks.push(Buffer.from(value)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function createHolidayCalendar({ cacheDir, fetchImpl = fetch, now = Date.now, timeoutMs = 4000 }) {
  const entries = new Map(), flights = new Map();
  async function load(year) {
    if (entries.has(year)) return entries.get(year);
    const entry = { cached: null, retryAt: 0, warning: null };
    try {
      const file = path.join(cacheDir, `${year}.json`);
      if ((await fs.stat(file)).size > LIMIT) throw new Error('Cache too large');
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      const time = Date.parse(raw.fetchedAt);
      if (!Number.isFinite(time) || time > now() + 300000 || !holidaySources(year).includes(raw.source)) throw new Error('Invalid cache metadata');
      entry.cached = { ...validateHolidayData(raw, year), source: raw.source, fetchedAt: raw.fetchedAt };
    } catch { /* Missing or damaged caches never prevent calendar use. */ }
    if (entries.has(year)) return entries.get(year);
    entries.set(year, entry);
    if (entries.size > 12) { const key = [...entries.keys()].find((key) => key !== year && !flights.has(key)); if (key != null) entries.delete(key); }
    return entry;
  }
  function refresh(year, entry) {
    if (flights.has(year)) return flights.get(year);
    if (flights.size >= 4) { entry.retryAt = now() + 10000; return Promise.resolve(); }
    const work = (async () => {
      for (const source of holidaySources(year)) {
        try {
          const response = await fetchImpl(source, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
          const data = validateHolidayData(await boundedJson(response), year);
          const cached = { ...data, source, fetchedAt: new Date(now()).toISOString() };
          entry.cached = cached; entry.warning = null; entry.retryAt = now() + DAY;
          const file = path.join(cacheDir, `${year}.json`), temp = `${file}.${process.pid}.tmp`;
          try { await fs.mkdir(cacheDir, { recursive: true }); await fs.writeFile(temp, JSON.stringify(cached), 'utf8'); await fs.rename(temp, file); }
          catch { entry.warning = '数据已获取，但本地缓存保存失败'; await fs.unlink(temp).catch(() => {}); }
          return;
        } catch { /* Try the second fixed provider; never overwrite good data with a failure. */ }
      }
      entry.retryAt = now() + 300000;
      entry.warning = entry.cached ? '更新失败，暂用本地缓存' : '节假日数据暂不可用，未标休班';
    })().finally(() => flights.delete(year));
    flights.set(year, work); return work;
  }
  return {
    async get(year) {
      if (!Number.isInteger(year) || year < 1000 || year > 9999) throw Object.assign(new Error('年份格式不正确'), { statusCode: 400 });
      const entry = await load(year);
      const fresh = entry.cached && now() - Date.parse(entry.cached.fetchedAt) < DAY;
      if (!fresh && now() >= entry.retryAt) {
        const pending = refresh(year, entry);
        if (!entry.cached) await pending;
      }
      const stale = Boolean(entry.cached && now() - Date.parse(entry.cached.fetchedAt) >= DAY);
      return { year, region: 'CN', status: entry.cached ? 'available' : 'unavailable', dates: entry.cached?.dates || [], source: entry.cached?.source || null, fetchedAt: entry.cached?.fetchedAt || null, stale, warning: entry.warning || (stale ? '数据可能不是最新，暂用本地缓存' : entry.cached ? null : '节假日数据暂不可用，未标休班') };
    },
  };
}
