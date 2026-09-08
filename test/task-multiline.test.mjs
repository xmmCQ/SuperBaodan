import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkTodo } from '../lib/tasks.mjs';
import { addTaskMarkdown, updateTaskMarkdown, moveTaskDateMarkdown, deleteTaskMarkdown } from '../lib/task-writer.mjs';

test('任务换行经过新增、编辑、完成、改期和删除仍保持结构完整', () => {
  const source = '# 工作\r\n- [ ] 原有事项 📅 2026-09-08';
  const text = '第一行\n\n第二行\n- 说明内容';
  let md = addTaskMarkdown(source, { text: text.replace(/\n/g, '\r\n'), dueDate: '2026-09-09' }, '2026-09-08');
  assert.equal(md.split('\r\n').length, source.split('\r\n').length + 1);
  let tasks = parseWorkTodo(md);
  assert.equal(tasks.length, 2);
  let task = tasks[1];
  assert.equal(task.text, text);
  assert.equal(task.editableText, text);
  assert.equal(task.dueDate, '2026-09-09');
  const edited = '更新内容\n第二行\n第三行';
  md = updateTaskMarkdown(md, task.id, { text: edited, recurrence: 'week' }, '2026-09-08');
  task = parseWorkTodo(md)[1];
  assert.equal(task.editableText, edited);
  md = updateTaskMarkdown(md, task.id, { checked: true }, '2026-09-08');
  task = parseWorkTodo(md)[1];
  assert.equal(task.text, edited);
  assert.equal(task.checked, true);
  md = moveTaskDateMarkdown(md, task.id, task.dueDate, '2026-09-10');
  task = parseWorkTodo(md)[1];
  assert.equal(task.editableText, edited);
  assert.equal(task.recurrence, 'week');
  md = deleteTaskMarkdown(md, task.id);
  assert.equal(md, source);
});

test('读取既有换行标记，不改变相邻任务、子任务或标签文本', () => {
  const tasks = parseWorkTodo('- [ ] 一<br>二<br/>三<BR />四 📅 2026-09-08\n  - [ ] 子任务\n- [ ] <script>文字</script>\n');
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].editableText, '一\n二\n三\n四');
  assert.equal(tasks[1].text, '子任务');
  assert.equal(tasks[2].text, '<script>文字</script>');
});
