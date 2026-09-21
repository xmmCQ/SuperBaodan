import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseWorkTodo, buildDashboard, buildDayDetails } from '../app/services/domain/tasks.mjs';
import { addTaskMarkdown, updateTaskMarkdown, moveTaskDateMarkdown, deleteTaskMarkdown } from '../app/services/domain/task-writer.mjs';
const today = '2026-09-10';
const create = input => addTaskMarkdown('', { kind: 'longterm', text: '持续事项', ...input }, today);
const one = source => parseWorkTodo(source)[0];

for (let mask = 0; mask < 8; mask++) test(`持续时间选填组合 ${mask}`, () => {
  const input = { startDate: mask & 1 ? '2026-09-01' : null, endDate: mask & 2 ? '2026-09-30' : null, recurrence: mask & 4 ? 'week' : null };
  const source = create(input), task = one(source);
  for (const key of Object.keys(input)) assert.equal(task[key], input[key]);
  assert.equal(task.kind, 'longterm'); assert.equal(task.plannedDate, undefined); assert.equal(task.dueDate, undefined);
  assert.equal(buildDashboard([task], { today }).longTerm.length, 1);
  assert.equal(task.editableText, '持续事项'); assert.equal(task.text, '持续事项');
  assert.equal((source.match(/baodan:kind=/g) || []).length, 1);
});
test('旧事项统一新类型语义，日历投影与非遗留统计仍保持原基线', () => {
  const source = '# 普通\n- [ ] 普通 ⏳ 2026-09-01 📅 2026-09-12\n# 长期工作\n- [ ] 单边 ⏳ 2026-09-01\n- [ ] 双边 ⏳ 2026-09-03 📅 2026-09-15\n- [x] 完成 📅 2026-09-05 ✅ 2026-09-06\n- [ ] ~~取消~~ 📅 2026-09-01\n- [ ] 冲突 ✅ 2026-09-01\n# 循环任务\n- [ ] 循环 🔁 every day\n';
  const tasks = parseWorkTodo(source), d = buildDashboard(tasks, { today });
  const result = { events: d.events, pending: d.pendingByDate, counts: { total: d.counts.total, unfinished: d.counts.unfinished, longTerm: d.counts.longTerm }, longTerm: d.longTerm.map(t => t.id), days: Array.from({ length: 30 }, (_, i) => buildDayDetails(tasks, `2026-09-${String(i + 1).padStart(2, '0')}`).map(t => [t.id, t.roles])) };
  // Pre-change projection, excluding only the explicitly retired legacy overdue rule.
  assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), 'ceeb0effbd35ad48c774268b31edff111f534cb29caf95334ea1cac6e32e642a');
  assert.deepEqual(d.overdue, []); assert.equal(d.counts.overdue, 0);
});
test('旧中文频率清空后保留正文与长期类型，不重新推断循环', () => {
  const source = '- [ ] 每周 维护客户\n', task = one(source);
  assert.equal(task.recurrence, 'week');
  const updated = one(updateTaskMarkdown(source, task.id, { recurrence: null }, today));
  assert.equal(updated.kind, 'longterm'); assert.equal(updated.recurrence, null); assert.equal(updated.text, '每周 维护客户');
});
test('真实日期、区间、类型及混用字段严格校验', () => {
  assert.doesNotThrow(() => create({ startDate: '2024-02-29', endDate: '2024-02-29' }));
  for (const input of [{ startDate: '2026-02-29' }, { endDate: '2026-04-31' }, { startDate: '2026-09-02', endDate: '2026-09-01' }, { recurrence: 'quarter' }, { kind: 'other' }, { text: '' }, { dueDate: today }]) assert.throws(() => create(input), { statusCode: 400 });
  for (const input of [{ text: '空时间' }, { kind: 'daily', text: '循环', dueDate: today, recurrence: 'day' }, { kind: 'daily', text: '混用', plannedDate: today, startDate: today }]) assert.throws(() => addTaskMarkdown('', input, today), { statusCode: 400 });
});
test('清空、完成、取消完成及完成日移动保持类型和起止日期', () => {
  let source = create({ startDate: '2026-10-01', endDate: '2026-11-01', recurrence: 'day' });
  source = updateTaskMarkdown(source, one(source).id, { checked: true }, today);
  assert.equal(one(source).startDate, '2026-10-01'); assert.equal(one(source).endDate, '2026-11-01');
  source = moveTaskDateMarkdown(source, one(source).id, today, '2026-09-11');
  assert.equal(one(source).startDate, '2026-10-01'); assert.equal(one(source).endDate, '2026-11-01');
  source = updateTaskMarkdown(source, one(source).id, { checked: false, startDate: null, endDate: null, recurrence: null }, today);
  assert.equal(one(source).kind, 'longterm'); assert.equal(one(source).completedDate, null);
  assert.equal(buildDashboard(parseWorkTodo(source), { today }).longTerm.length, 1);
  assert.throws(() => updateTaskMarkdown(source, one(source).id, { kind: 'daily' }, today), /类型/);
  assert.throws(() => updateTaskMarkdown(source, one(source).id, { plannedDate: today }, today), /混用/);
  const sameDay = create({ startDate: today, endDate: '2026-10-01', checked: true });
  const moved = one(moveTaskDateMarkdown(sameDay, one(sameDay).id, today, '2026-09-11'));
  assert.equal(moved.startDate, today); assert.equal(moved.completedDate, '2026-09-11');
});
test('旧类型不受状态影响，新旧持续工作均不因起始日已过而进入遗留', () => {
  const source = '# 长期工作\n- [ ] 起始 ⏳ 2026-09-01\n- [x] 完成 ⏳ 2026-09-01 ✅ 2026-09-02\n- [ ] ~~取消~~\n- [ ] 冲突 ✅ 2026-09-01\n';
  const tasks = parseWorkTodo(source), dashboard = buildDashboard(tasks, { today });
  assert.ok(tasks.every(t => t.kind === 'longterm')); assert.equal(dashboard.longTerm.length, 1); assert.equal(dashboard.overdue.length, 0);
  const fresh = one(create({ startDate: '2026-09-01' }));
  assert.equal(buildDashboard([fresh], { today }).overdue.length, 0);
  assert.equal(buildDayDetails([fresh], '2026-09-01').length, 1);
  assert.equal(buildDayDetails([fresh], '2026-09-02').length, 0);
  assert.deepEqual(buildDashboard([fresh], { today }).pendingByDate, { '2026-09-01': 1 });
  const renamed = updateTaskMarkdown(source, tasks[0].id, { text: '只改文字' }, today);
  assert.equal(buildDashboard(parseWorkTodo(renamed), { today }).overdue.length, 0);
  assert.equal(one(renamed).startDate, '2026-09-01');
  assert.equal(Object.hasOwn(one(renamed), 'legacyDateProjection'), false);
  const edited = updateTaskMarkdown(source, tasks[0].id, { startDate: null, endDate: null, recurrence: null }, today);
  assert.equal(one(edited).kind, 'longterm'); assert.equal(one(edited).startDate, null);
  const ended = one(create({ endDate: '2026-09-01' })), endedDashboard = buildDashboard([ended], { today });
  assert.equal(ended.checked, false); assert.equal(endedDashboard.longTerm.length, 1); assert.equal(endedDashboard.overdue.length, 1);
  const oldEnded = parseWorkTodo('# 长期工作\n- [ ] 旧终止 📅 2026-09-01\n');
  assert.equal(buildDashboard(oldEnded, { today }).overdue.length, 1);
  const daily = parseWorkTodo('- [ ] 每日 ⏳ 2026-09-01\n');
  assert.equal(buildDashboard(daily, { today }).overdue.length, 1);
});
test('标记不污染正文、父标题；异常标记拒绝而任意注释不删除', () => {
  const source = '- [ ] 父 <!-- note --> <!-- baodan:kind=longterm -->\n  - [ ] 子 <!-- baodan:kind=daily -->';
  const tasks = parseWorkTodo(source); assert.deepEqual(tasks[1].parentTasks, ['父 <!-- note -->']);
  assert.equal(tasks[0].text, '父 <!-- note -->');
  for (const marker of ['<!-- baodan:kind=alien', '<!-- baodan:kind=alien -->', '<!-- baodan:kind=daily --> <!-- baodan:kind=longterm -->']) assert.throws(() => parseWorkTodo(`- [ ] 异常 ${marker}`), /标记/);
});
test('新建章节边界、BOM、CRLF、非目标事项及多行内容保留', () => {
  const original = '\ufeff# 普通\r\n- [ ] 原任务 📅 2026-09-10\r\n备注 <!-- private -->\r\n';
  let source = addTaskMarkdown(original, { kind: 'longterm', text: '第一行\n第二行' }, today);
  assert.ok(source.startsWith(original)); assert.match(source, /# 持续工作\r\n/); assert.match(source, /第一行<br>第二行/);
  source = addTaskMarkdown(source, { text: '每日', dueDate: today }, today);
  assert.ok(source.indexOf('每日') < source.indexOf('# 持续工作')); assert.ok(source.startsWith('\ufeff')); assert.ok(source.endsWith('\r\n'));
  const task = parseWorkTodo(source).find(t => t.kind === 'longterm');
  const removed = deleteTaskMarkdown(source, task.id); assert.match(removed, /原任务 📅 2026-09-10\r\n备注 <!-- private -->/);
  assert.equal(addTaskMarkdown('', { text: '无末尾换行', dueDate: today }, today).endsWith('\n'), false);
  assert.equal(create({}).endsWith('\n'), false);
  const nested = addTaskMarkdown('# 项目\n## 持续工作\n备注\n', { kind: 'longterm', text: '复用章节' }, today);
  assert.equal((nested.match(/持续工作/g) || []).length, 1);
  assert.match(nested, /## 持续工作\n- \[ \] 复用章节/);
  assert.throws(() => moveTaskDateMarkdown(create({ startDate: '2026-09-01', endDate: '2026-09-10' }), one(create({ startDate: '2026-09-01', endDate: '2026-09-10' })).id, '2026-09-01', '2026-09-11'), /终止日/);
});
