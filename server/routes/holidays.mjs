import path from 'node:path';
import { createHolidayCalendar } from '../../lib/holiday-calendar.mjs';
import { assertLocalRequest, json } from '../response.mjs';

export function registerHolidayRoutes(router) {
  let service;
  router.get('/api/holidays', async (req, res, url, _match, context) => {
    assertLocalRequest(req, context.config);
    const raw = url.searchParams.get('year');
    if (!/^[1-9]\d{3}$/.test(raw || '')) return json(res, 400, { error: '年份格式不正确' });
    service ||= createHolidayCalendar({ cacheDir: context.config.holidayCacheDir || path.join(path.dirname(context.config.todoFile || context.config.publicDir), 'holiday-cache') });
    res.setHeader('Cache-Control', 'no-store');
    json(res, 200, await service.get(Number(raw)));
  });
}
