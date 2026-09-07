import test from "node:test";
import assert from "node:assert/strict";
import { addTaskMarkdown, deleteTaskMarkdown, moveTaskDateMarkdown, updateTaskMarkdown } from "../lib/task-writer.mjs";
import { parseWorkTodo } from "../lib/tasks.mjs";

const source = `- [ ] 普通任务 [[关联文档]] ⏳ 2026-08-27 📅 2026-08-29
- [x] 已完成任务 📅 2026-08-26 ✅ 2026-08-27

# 循环任务
- [ ] 每周治理 🔁 every week
`;

test("标记完成时写入勾选状态和实际完成日", () => {
  const task = parseWorkTodo(source)[0];
  const updated = updateTaskMarkdown(source, task.id, { checked: true }, "2026-08-28");
  assert.match(updated, /- \[x\] 普通任务 \[\[关联文档\]\] ⏳ 2026-08-27 📅 2026-08-28 ✅ 2026-08-28/);
  const parsed = parseWorkTodo(updated)[0];
  assert.equal(parsed.checked, true);
  assert.equal(parsed.completedDate, "2026-08-28");
});

test("提前完成未来计划时计划日、截止日和完成日都改为实际完成日", () => {
  const markdown = "- [ ] 9月计划任务 ⏳ 2026-09-01 📅 2026-09-05\n";
  const task = parseWorkTodo(markdown)[0];
  const updated = updateTaskMarkdown(markdown, task.id, { checked: true }, "2026-08-31");
  assert.match(updated, /- \[x\] 9月计划任务 ⏳ 2026-08-31 📅 2026-08-31 ✅ 2026-08-31/);
  const parsed = parseWorkTodo(updated)[0];
  assert.equal(parsed.plannedDate, "2026-08-31");
  assert.equal(parsed.dueDate, "2026-08-31");
  assert.equal(parsed.completedDate, "2026-08-31");
});

test("逾期完成时保留历史截止日", () => {
  const markdown = "- [ ] 逾期任务 📅 2026-08-27\n";
  const task = parseWorkTodo(markdown)[0];
  const updated = updateTaskMarkdown(markdown, task.id, { checked: true }, "2026-08-31");
  assert.match(updated, /- \[x\] 逾期任务 📅 2026-08-27 ✅ 2026-08-31/);
});

test("取消完成时移除实际完成日", () => {
  const task = parseWorkTodo(source)[1];
  const updated = updateTaskMarkdown(source, task.id, { checked: false }, "2026-08-28");
  assert.match(updated, /- \[ \] 已完成任务 📅 2026-08-26/);
  assert.doesNotMatch(updated, /已完成任务.*✅/);
});

test("修改事项文字和日期后保留其他Markdown语义", () => {
  const task = parseWorkTodo(source)[2];
  const updated = updateTaskMarkdown(source, task.id, {
    text: "每周知识治理 🔁 every week",
    plannedDate: "2026-09-01",
    dueDate: "2026-09-05",
  }, "2026-08-28");
  assert.match(updated, /每周知识治理 🔁 every week ⏳ 2026-09-01 📅 2026-09-05/);
  const parsed = parseWorkTodo(updated).find((item) => item.text === "每周知识治理");
  assert.equal(parsed.recurrence, "week");
});

test("新增计划插入循环任务区块之前并可再次解析", () => {
  const updated = addTaskMarkdown(source, {
    text: "网页新增计划",
    plannedDate: "2026-08-30",
    dueDate: "2026-09-02",
    checked: false,
  }, "2026-08-28");
  assert.ok(updated.indexOf("网页新增计划") < updated.indexOf("# 循环任务"));
  const task = parseWorkTodo(updated).find((item) => item.text === "网页新增计划");
  assert.equal(task.plannedDate, "2026-08-30");
  assert.equal(task.dueDate, "2026-09-02");
});

test("可新增无日期的每月循环任务并写入循环区块", () => {
  const updated = addTaskMarkdown(source, {
    text: "月度复盘",
    recurrence: "month",
    checked: false,
  }, "2026-08-28");
  assert.match(updated, /# 循环任务\n- \[ \] 月度复盘 🔁 every month/);
  const task = parseWorkTodo(updated).find((item) => item.text === "月度复盘");
  assert.equal(task.recurrence, "month");
  assert.equal(task.editableText, "月度复盘");
});

test("可修改或移除循环频率", () => {
  const task = parseWorkTodo(source).find((item) => item.recurrence === "week");
  const monthly = updateTaskMarkdown(source, task.id, { recurrence: "month" }, "2026-08-28");
  assert.match(monthly, /每周治理 🔁 every month/);
  assert.doesNotMatch(monthly, /每周治理 🔁 every week/);

  const monthlyTask = parseWorkTodo(monthly).find((item) => item.text === "每周治理");
  const removed = updateTaskMarkdown(monthly, monthlyTask.id, { recurrence: null }, "2026-08-28");
  assert.doesNotMatch(removed, /每周治理 🔁/);
});

test("拖动计划日或截止日时只修改对应日期", () => {
  const original = parseWorkTodo(source)[0];
  const movedPlan = moveTaskDateMarkdown(source, original.id, "2026-08-27", "2026-08-28");
  const afterPlan = parseWorkTodo(movedPlan)[0];
  assert.equal(afterPlan.plannedDate, "2026-08-28");
  assert.equal(afterPlan.dueDate, "2026-08-29");

  const movedDue = moveTaskDateMarkdown(movedPlan, afterPlan.id, "2026-08-29", "2026-08-30");
  const afterDue = parseWorkTodo(movedDue)[0];
  assert.equal(afterDue.plannedDate, "2026-08-28");
  assert.equal(afterDue.dueDate, "2026-08-30");
});

test("计划日和截止日相同时一起移动", () => {
  const equalDates = "- [ ] 同日事项 ⏳ 2026-08-28 📅 2026-08-28\n";
  const task = parseWorkTodo(equalDates)[0];
  const moved = moveTaskDateMarkdown(equalDates, task.id, "2026-08-28", "2026-09-01");
  const updated = parseWorkTodo(moved)[0];
  assert.equal(updated.plannedDate, "2026-09-01");
  assert.equal(updated.dueDate, "2026-09-01");
});

test("已完成事项改期时完成日始终跟随目标日期", () => {
  const task = parseWorkTodo(source)[1];
  const movedDue = moveTaskDateMarkdown(source, task.id, "2026-08-26", "2026-08-25");
  const afterDue = parseWorkTodo(movedDue)[1];
  assert.equal(afterDue.dueDate, "2026-08-25");
  assert.equal(afterDue.completedDate, "2026-08-25");

  const originalTask = parseWorkTodo(source)[1];
  const movedCompleted = moveTaskDateMarkdown(source, originalTask.id, "2026-08-27", "2026-08-30");
  const afterCompleted = parseWorkTodo(movedCompleted)[1];
  assert.equal(afterCompleted.dueDate, "2026-08-26");
  assert.equal(afterCompleted.completedDate, "2026-08-30");

  const completedWithPlan = "- [x] 完成事项 ⏳ 2026-08-20 📅 2026-08-28 ✅ 2026-08-25\n";
  const plannedTask = parseWorkTodo(completedWithPlan)[0];
  const movedPlan = moveTaskDateMarkdown(completedWithPlan, plannedTask.id, "2026-08-20", "2026-08-22");
  const afterPlan = parseWorkTodo(movedPlan)[0];
  assert.equal(afterPlan.plannedDate, "2026-08-22");
  assert.equal(afterPlan.dueDate, "2026-08-28");
  assert.equal(afterPlan.completedDate, "2026-08-22");
});

test("拒绝进行中、原地、越界和无匹配日期的拖动", () => {
  const task = parseWorkTodo(source)[0];
  assert.throws(() => moveTaskDateMarkdown(source, task.id, "2026-08-28", "2026-09-01"), /进行中事项暂不支持拖动/);
  assert.throws(() => moveTaskDateMarkdown(source, task.id, "2026-08-27", "2026-08-27"), /目标日期与原日期相同/);
  assert.throws(() => moveTaskDateMarkdown(source, task.id, "2026-08-27", "2026-08-30"), /计划日不能晚于截止日/);
  assert.throws(() => moveTaskDateMarkdown(source, task.id, "2026-08-20", "2026-08-21"), /没有可移动的日期/);
  assert.throws(() => moveTaskDateMarkdown(source, task.id, "2026-02-30", "2026-08-21"), /原日期格式不正确/);
});

test("拖动改期保留BOM、Windows换行、循环和缩进", () => {
  const bomSource = "\uFEFF  - [ ] 循环事项 🔁 every month ⏳ 2026-08-27\r\n";
  const task = parseWorkTodo(bomSource)[0];
  const moved = moveTaskDateMarkdown(bomSource, task.id, "2026-08-27", "2026-09-27");
  assert.ok(moved.startsWith("\uFEFF  - [ ] 循环事项 🔁 every month ⏳ 2026-09-27"));
  assert.match(moved, /\r\n$/);
});

test("删除工作事项后保留其他内容", () => {
  const task = parseWorkTodo(source)[0];
  const updated = deleteTaskMarkdown(source, task.id);
  assert.doesNotMatch(updated, /普通任务/);
  assert.match(updated, /已完成任务/);
  assert.match(updated, /# 循环任务/);
});

test("删除父事项时一并删除其缩进子内容", () => {
  const nested = `- [ ] 父事项 ⏳ 2026-08-28
  补充说明
  - [ ] 子事项
- [ ] 保留事项 ⏳ 2026-08-29
`;
  const parent = parseWorkTodo(nested)[0];
  const updated = deleteTaskMarkdown(nested, parent.id);
  assert.doesNotMatch(updated, /父事项|补充说明|子事项/);
  assert.match(updated, /保留事项/);
});

test("新增计划必须具备合法参数", () => {
  assert.throws(() => addTaskMarkdown(source, { text: "无日期" }, "2026-08-28"), /至少需要日期或循环频率/);
  assert.throws(() => addTaskMarkdown(source, { text: "", plannedDate: "2026-08-30" }, "2026-08-28"), /事项内容不能为空/);
  assert.throws(() => addTaskMarkdown(source, { text: "日期错误", plannedDate: "2026-02-30" }, "2026-08-28"), /计划日格式不正确/);
  assert.throws(() => addTaskMarkdown(source, { text: "状态错误", plannedDate: "2026-08-30", checked: "false" }, "2026-08-28"), /完成状态必须是布尔值/);
  assert.throws(() => addTaskMarkdown(source, { text: "频率错误", recurrence: "quarter" }, "2026-08-28"), /循环频率不正确/);
});

test("修改时保留UTF-8 BOM和Windows换行", () => {
  const bomSource = "\uFEFF- [ ] BOM任务 ⏳ 2026-08-27\r\n";
  const task = parseWorkTodo(bomSource)[0];
  const updated = updateTaskMarkdown(bomSource, task.id, { checked: true }, "2026-08-28");
  assert.ok(updated.startsWith("\uFEFF"));
  assert.match(updated, /\r\n$/);
  assert.doesNotMatch(updated.replace(/\r\n/g, ""), /\n/);
});
