import { fault } from "../../shared/errors.js";
import path from 'node:path';
import { createHolidayCalendar } from '../domain/holiday-calendar.mjs';

export function registerHolidayCommands(commands) {
  let service;
  commands.set("holidays.read", async (args, context) => {
    const raw = args.year;
    if (!/^[1-9]\d{3}$/.test(raw || '')) throw fault(400, '年份格式不正确');
    service ||= createHolidayCalendar({ cacheDir: context.config.holidayCacheDir || path.join(path.dirname(context.config.todoFile), 'holiday-cache') });
    return await service.get(Number(raw));
  });
}
