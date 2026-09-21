export const HOLIDAY_CACHE_KEY = 'super-baodan.holidays.v1';
const DAY = 86400000;

export function validHolidaySnapshot(data, year) {
  if (data?.status !== 'available' || data.region !== 'CN' || data.year !== year || !Number.isInteger(year) || year < 1000 || year > 9999) return false;
  if (!Array.isArray(data.dates) || !data.dates.length || data.dates.length > 366) return false;
  const time = Date.parse(data.fetchedAt);
  if (!Number.isFinite(time) || time > Date.now() + 300000) return false;
  const seen = new Set();
  return data.dates.every((item) => {
    if (!item || typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !item.date.startsWith(`${year}-`) || !Number.isFinite(Date.parse(item.date)) || new Date(item.date).toISOString().slice(0, 10) !== item.date || seen.has(item.date)) return false;
    seen.add(item.date);
    return ['public_holiday', 'transfer_workday'].includes(item.type) && typeof item.name === 'string' && Boolean(item.name.trim()) && item.name.length <= 120;
  });
}
function readSnapshots(storage) {
  const raw = storage.getItem(HOLIDAY_CACHE_KEY);
  if (!raw || raw.length > 1024 * 1024) return [];
  const envelope = JSON.parse(raw);
  if (envelope?.version !== 1 || !Array.isArray(envelope.years) || envelope.years.length > 12) return [];
  return envelope.years.filter((data) => validHolidaySnapshot(data, data?.year));
}
export function readHolidayCache(year, storage) {
  try {
    storage ||= globalThis.localStorage;
    const data = readSnapshots(storage).find((item) => item.year === year);
    if (!data) return null;
    const stale = Date.now() - Date.parse(data.fetchedAt) >= DAY;
    return { ...data, stale, warning: stale ? '使用较早的浏览器缓存，待后台核验' : null };
  } catch { return null; }
}
export function writeHolidayCache(data, storage) {
  if (!validHolidaySnapshot(data, data?.year)) return false;
  try {
    storage ||= globalThis.localStorage;
    let existing; try { existing = readSnapshots(storage); } catch { existing = []; }
    // Do not replace a newer snapshot with an older backend cache.
    const newer = existing.find((item) => item.year === data.year && Date.parse(item.fetchedAt) > Date.parse(data.fetchedAt));
    if (newer) return true;
    const snapshot = { year: data.year, region: 'CN', status: 'available', fetchedAt: data.fetchedAt, source: typeof data.source === 'string' ? data.source.slice(0, 300) : null, dates: data.dates.map(({ date, type, name }) => ({ date, type, name })) };
    const years = [snapshot, ...existing.filter((item) => item.year !== data.year)].slice(0, 12);
    storage.setItem(HOLIDAY_CACHE_KEY, JSON.stringify({ version: 1, years }));
    return true;
  } catch { return false; }
}
