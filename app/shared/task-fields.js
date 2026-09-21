import { fault } from './errors.js';

const KIND_MARKER = /<!-- baodan:kind=(daily|longterm) -->/g;
const MANAGED_MARKER = /<!--\s*baodan:kind=[\s\S]*?-->/g;

export function stripTaskKind(text) { return text.replace(KIND_MARKER, ''); }

export function readTaskKind(text) {
  const markers = text.match(MANAGED_MARKER) || [];
  const kinds = markers.map(marker => /^<!-- baodan:kind=(daily|longterm) -->$/.exec(marker)?.[1]);
  if (/<!--\s*baodan:kind=/.test(text.replace(MANAGED_MARKER, '')) || kinds.some(kind => !kind) || new Set(kinds).size > 1) throw fault(400, '事项类型标记未知或冲突，请检查源文件');
  return kinds[0] || null;
}

// Classification is independent of completion, cancellation and list visibility.
export function taskKind(task) {
  return task.kind || (task.recurrence || /循环任务|无DL工作|长期工作|长期规划|持续工作/.test((task.headingPath || []).join('/')) ? 'longterm' : 'daily');
}

// Projection slots are internal; API/form fields remain distinct.
export function taskDates(task) {
  return taskKind(task) === 'longterm'
    ? { plannedDate: Object.hasOwn(task, 'startDate') ? task.startDate : task.plannedDate ?? null, dueDate: Object.hasOwn(task, 'endDate') ? task.endDate : task.dueDate ?? null }
    : { plannedDate: task.plannedDate, dueDate: task.dueDate };
}

export function validateTaskTimes(kind, input, requireDailyDate = false) {
  if (!['daily', 'longterm'].includes(kind)) throw fault(400, '事项类型必须是daily或longterm');
  const longterm = kind === 'longterm';
  const forbidden = longterm ? ['plannedDate', 'dueDate'] : ['startDate', 'endDate', 'recurrence'];
  if (forbidden.some(key => input[key] !== undefined && input[key] !== null && input[key] !== '')) {
    throw fault(400, longterm ? '持续工作请使用起始日、终止日，不能混用计划日、截止日' : '每日工作不能设置起始日、终止日或循环频率');
  }
  const fields = longterm ? [['startDate', '起始日'], ['endDate', '终止日']] : [['plannedDate', '计划日'], ['dueDate', '截止日']];
  for (const [key, label] of fields) {
    const value = input[key];
    if (value === null || value === undefined || value === '') continue;
    const parsed = new Date(`${value}T00:00:00Z`);
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw fault(400, `${label}格式不正确`);
  }
  if (longterm) {
    if (input.recurrence != null && input.recurrence !== '' && !['day', 'week', 'month', 'year'].includes(input.recurrence)) throw fault(400, '循环频率不正确');
    if (input.startDate && input.endDate && input.endDate < input.startDate) throw fault(400, '终止日不能早于起始日');
  } else if (requireDailyDate && !input.plannedDate && !input.dueDate) throw fault(400, '新增每日工作至少需要计划日或截止日');
}
