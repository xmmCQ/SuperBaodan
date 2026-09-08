import { readHolidayCache, writeHolidayCache, validHolidaySnapshot } from './holiday-cache.js';

export function holidayInfo(date, data) {
  if (data?.status !== 'available') return { mark: '', text: '节假日数据未获取，调休安排未核验' };
  const special = data.dates.find((item) => item.date === date);
  if (special?.type === 'transfer_workday') return { mark: '班', kind: 'work', text: `${special.name} · 调休上班` };
  if (special?.type === 'public_holiday') return { mark: '休', kind: 'rest', text: `${special.name} · 放假` };
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6 ? { mark: '休', kind: 'rest', text: '周末休息' } : { mark: '', text: '' };
}

export function createHolidayMarks({ container, api }) {
  const years = new Map();
  const footer = document.createElement('div'); footer.className = 'holiday-footer';
  const status = document.createElement('span'); status.className = 'holiday-status'; status.setAttribute('role', 'status');
  footer.append(status); container.parentElement.append(footer);
  const visibleYears = () => [...new Set([...container.querySelectorAll('[data-date]')].map((node) => Number(node.dataset.date.slice(0, 4))))];
  function apply() {
    for (const button of container.querySelectorAll('[data-date]')) {
      const entry = years.get(Number(button.dataset.date.slice(0, 4))), data = entry?.data;
      const info = holidayInfo(button.dataset.date, data);
      button.querySelector('.holiday-badge')?.remove();
      if (info.mark) { const badge = document.createElement('span'); badge.className = `holiday-badge holiday-${info.kind}`; badge.textContent = info.mark; badge.setAttribute('aria-hidden', 'true'); button.append(badge); }
      // Keep date buttons and their existing drag/click listeners intact during async updates.
      const base = button.dataset.holidayBaseLabel || button.getAttribute('aria-label') || '';
      button.dataset.holidayBaseLabel = base;
      button.setAttribute('aria-label', [base, info.text].filter(Boolean).join('，'));
      if (!Object.hasOwn(button.dataset, 'holidayBaseTooltip')) button.dataset.holidayBaseTooltip = button.dataset.tooltip || '';
      const tooltip = info.mark ? '' : button.dataset.holidayBaseTooltip;
      if (tooltip) {
        button.dataset.tooltip = tooltip;
        button.classList.add('tooltip-control', 'tooltip-down');
      } else {
        delete button.dataset.tooltip;
        button.classList.remove('tooltip-control', 'tooltip-down');
      }
    }
    const messages = visibleYears().map((year) => {
      const entry = years.get(year);
      if (!entry?.data) return `${year}年节假日数据加载中`;
      if (entry.data.status !== 'available') return `${year}年数据不可用，未标休班`;
      return entry.data.warning ? `${year}年：${entry.data.warning}` : '';
    }).filter(Boolean);
    const text = messages.join('；'); if (status.textContent !== text) status.textContent = text;
    status.hidden = !messages.length;
    footer.hidden = !messages.length;
  }
  function refresh() {
    for (const year of visibleYears()) {
      let entry = years.get(year);
      if (!entry) { entry = { data: readHolidayCache(year), loadedAt: 0, flight: null }; years.set(year, entry); }
      if (entry.flight || Date.now() - entry.loadedAt < 300000) continue;
      entry.flight = Promise.resolve().then(() => api(`/api/holidays?year=${year}`, { cache: 'no-store' })).then((data) => {
        if (!validHolidaySnapshot(data, year)) throw new Error('Holiday data unavailable or invalid');
        if (entry.data?.status === 'available' && Date.parse(entry.data.fetchedAt) > Date.parse(data.fetchedAt)) {
          entry.data = { ...entry.data, warning: '服务端缓存较早，暂用已获取数据' };
          return;
        }
        entry.data = data;
        if (!writeHolidayCache(data)) entry.data = { ...data, warning: data.warning || '浏览器缓存保存失败，当前页面仍可使用' };
      }).catch(() => {
        entry.data = entry.data?.status === 'available' ? { ...entry.data, stale: true, warning: '更新失败，暂用已获取数据' } : { year, status: 'unavailable', dates: [] };
      }).finally(() => { entry.loadedAt = Date.now(); entry.flight = null; apply(); });
    }
    if (years.size > 12) for (const [year, entry] of years) { if (years.size <= 12) break; if (!entry.flight && !visibleYears().includes(year)) years.delete(year); }
    apply();
  }
  return { refresh };
}
