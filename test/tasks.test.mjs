import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboard, buildDayDetails, parseWorkTodo } from "../lib/tasks.mjs";

const fixture = `
- [ ] 今日计划 ⏳ 2026-08-27
- [ ] 今日截止 📅 2026-08-27
- [x] 已完成事项 ⏳ 2026-08-25 ✅ 2026-08-27
- [ ] 跨日事项 ⏳ 2026-08-25 📅 2026-08-29
- [ ] 逾期事项 📅 2026-08-20
- [ ] 状态冲突 📅 2026-08-20 ✅ 2026-08-21
# 循环任务
- [ ] 每周治理 🔁 every week
- [ ] 每月复盘 🔁 every month
- [x] 已完成循环 🔁 every week ✅ 2026-08-20
## 无DL工作
- [ ] 长期规划
- [ ] ~~暂缓事项~~
- [ ] 明文暂缓事项——暂缓
`;

const tasks = parseWorkTodo(fixture);

test("解析任务状态、日期、循环和标题", () => {
  assert.equal(tasks.length, 12);
  assert.equal(tasks[0].plannedDate, "2026-08-27");
  assert.equal(tasks[1].dueDate, "2026-08-27");
  assert.equal(tasks[2].completedDate, "2026-08-27");
  assert.equal(tasks[5].conflict, true);
  assert.equal(tasks[6].recurrence, "week");
  assert.equal(tasks[6].editableText, "每周治理");
  assert.equal(tasks[7].recurrence, "month");
  assert.deepEqual(tasks[6].headingPath, ["循环任务"]);
  assert.equal(tasks[10].cancelled, true);
  assert.equal(tasks[11].cancelled, true);
});

test("生成遗留工作、长期工作和月历事件", () => {
  const result = buildDashboard(tasks, { today: "2026-08-27", month: "2026-08" });
  assert.deepEqual(result.overdue.map((item) => item.text), ["逾期事项"]);
  assert.deepEqual(result.longTerm.map((item) => item.text), ["每周治理", "每月复盘", "长期规划"]);
  assert.ok(result.events.some((event) => event.date === "2026-08-27" && event.roles.includes("completed")));
  assert.deepEqual(result.pendingByDate, {
    "2026-08-20": 1,
    "2026-08-25": 1,
    "2026-08-26": 1,
    "2026-08-27": 3,
    "2026-08-28": 1,
    "2026-08-29": 1,
  });
});

test("日期内事项全部完成时月历只返回完成状态", () => {
  const completedTasks = parseWorkTodo(`
- [x] 完成事项A ⏳ 2026-08-05 📅 2026-08-06 ✅ 2026-08-07
- [x] 完成事项B ⏳ 2026-08-05 ✅ 2026-08-08
`);
  const result = buildDashboard(completedTasks, { today: "2026-08-09", month: "2026-08" });
  for (const date of ["2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"]) {
    const dayEvents = result.events.filter((event) => event.date === date);
    assert.ok(dayEvents.length > 0);
    assert.ok(dayEvents.every((event) => event.checked));
    assert.ok(dayEvents.every((event) => event.roles.length === 1 && event.roles[0] === "completed"));
  }
});

test("待办日期按月截取区间并对同一事项去重", () => {
  const crossMonth = parseWorkTodo(`
- [ ] 跨月事项 ⏳ 2026-07-30 📅 2026-08-02
- [ ] 同日事项 ⏳ 2026-08-05 📅 2026-08-05
- [x] 已完成跨月 ⏳ 2026-07-30 📅 2026-08-03 ✅ 2026-08-03
- [ ] ~~暂缓事项~~ ⏳ 2026-08-04
- [ ] 状态冲突 📅 2026-08-06 ✅ 2026-08-06
`);
  const result = buildDashboard(crossMonth, { today: "2026-08-01", month: "2026-08" });
  assert.deepEqual(result.pendingByDate, {
    "2026-08-01": 1,
    "2026-08-02": 1,
    "2026-08-05": 1,
  });
});

test("点击日期展示计划、截止、完成和进行中事项", () => {
  const details = buildDayDetails(tasks, "2026-08-27");
  const byText = new Map(details.map((item) => [item.text, item.roles]));
  assert.deepEqual(byText.get("今日计划"), ["planned"]);
  assert.deepEqual(byText.get("今日截止"), ["due"]);
  assert.deepEqual(byText.get("已完成事项"), ["completed"]);
  assert.deepEqual(byText.get("跨日事项"), ["ongoing"]);
});
