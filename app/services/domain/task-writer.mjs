import { fault } from '../../shared/errors.js';
import { parseWorkTodo } from "./tasks.mjs";
import { taskDates, validateTaskTimes, readTaskKind, stripTaskKind } from '../../shared/task-fields.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RECURRENCES = new Set(["day", "week", "month", "year"]);

export function updateTaskMarkdown(markdown, taskId, patch, completedOn) {
  const document = splitMarkdown(markdown);
  const { lines } = document;
  const task = parseWorkTodo(markdown).find((item) => item.id === taskId);
  if (!task) throw fault(404, "未找到该工作事项，请刷新后重试");

  const text = patch.text === undefined ? task.editableText : normalizeText(patch.text);
  const kind = task.kind;
  if (patch.kind !== undefined && patch.kind !== kind) throw fault(400, '不能通过编辑变更事项类型');
  validateTaskTimes(kind, patch);
  const longterm = kind === 'longterm';
  const first = longterm ? 'startDate' : 'plannedDate', last = longterm ? 'endDate' : 'dueDate';
  let plannedDate = patch[first] === undefined ? taskDates(task).plannedDate : normalizeOptionalDate(patch[first], longterm ? '起始日' : '计划日');
  let dueDate = patch[last] === undefined ? taskDates(task).dueDate : normalizeOptionalDate(patch[last], longterm ? '终止日' : '截止日');
  // A completion-only operation must also work for unedited legacy date ranges.
  if (longterm && (patch[first] !== undefined || patch[last] !== undefined)) validateTaskTimes(kind, { startDate: plannedDate, endDate: dueDate });
  const recurrence = normalizeRecurrence(patch.recurrence, task.recurrence);
  const checked = normalizeChecked(patch.checked, task.checked);
  const justCompleted = checked && !task.checked;
  const completedToday = checked ? normalizeRequiredDate(completedOn, "完成日") : null;
  const completedDate = checked ? (justCompleted ? completedToday : task.completedDate || completedToday) : null;
  if (!longterm && justCompleted && plannedDate && plannedDate > completedDate) plannedDate = completedDate;
  if (!longterm && justCompleted && dueDate && dueDate > completedDate) dueDate = completedDate;

  lines[task.sourceLine - 1] = formatTaskLine({
    indent: task.sourceIndent,
    kind,
    checked,
    text,
    plannedDate,
    dueDate,
    recurrence,
    completedDate,
  });

  return joinMarkdown(document);
}

export function moveTaskDateMarkdown(markdown, taskId, sourceDateValue, targetDateValue) {
  const document = splitMarkdown(markdown);
  const { lines } = document;
  const task = parseWorkTodo(markdown).find((item) => item.id === taskId);
  if (!task) throw fault(404, "未找到该工作事项，请刷新后重试");

  const sourceDate = normalizeRequiredDate(sourceDateValue, "原日期");
  const targetDate = normalizeRequiredDate(targetDateValue, "目标日期");
  if (sourceDate === targetDate) throw fault(400, "目标日期与原日期相同");

  let { plannedDate, dueDate } = taskDates(task);
  let completedDate = task.completedDate;
  if (task.kind === 'longterm' && task.checked && completedDate === sourceDate) {
    completedDate = targetDate;
  } else if (plannedDate === sourceDate && dueDate === sourceDate) {
    plannedDate = targetDate;
    dueDate = targetDate;
  } else if (plannedDate === sourceDate) {
    plannedDate = targetDate;
  } else if (dueDate === sourceDate) {
    dueDate = targetDate;
  } else if (task.checked && completedDate === sourceDate) {
    completedDate = targetDate;
  } else if (plannedDate && dueDate && plannedDate < sourceDate && sourceDate < dueDate) {
    throw fault(400, "进行中事项暂不支持拖动，请使用编辑功能改期");
  } else {
    throw fault(400, "该事项在当前日期没有可移动的日期");
  }

  if (plannedDate && dueDate && plannedDate > dueDate) {
    throw fault(400, task.kind === 'longterm' ? '终止日不能早于起始日' : '计划日不能晚于截止日');
  }
  if (task.checked && task.kind !== 'longterm') completedDate = targetDate;

  lines[task.sourceLine - 1] = formatTaskLine({
    indent: task.sourceIndent,
    kind: task.kind,
    checked: task.checked,
    text: task.editableText,
    plannedDate,
    dueDate,
    recurrence: task.recurrence,
    completedDate,
  });
  return joinMarkdown(document);
}

export function deleteTaskMarkdown(markdown, taskId) {
  const document = splitMarkdown(markdown);
  const { lines } = document;
  const task = parseWorkTodo(markdown).find((item) => item.id === taskId);
  if (!task) throw fault(404, "未找到该工作事项，请刷新后重试");

  const start = task.sourceLine - 1;
  const baseIndent = indentWidth(task.sourceIndent);
  let end = start + 1;
  while (end < lines.length) {
    if (!lines[end].trim()) {
      let next = end + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      if (next < lines.length && indentWidth(lines[next].match(/^\s*/)?.[0] || "") > baseIndent) {
        end = next;
        continue;
      }
      break;
    }
    if (indentWidth(lines[end].match(/^\s*/)?.[0] || "") <= baseIndent) break;
    end += 1;
  }
  lines.splice(start, end - start);
  return joinMarkdown(document);
}

export function addTaskMarkdown(markdown, input, completedOn) {
  parseWorkTodo(markdown); // Reject unknown/conflicting management data before any write.
  const document = splitMarkdown(markdown);
  const { lines } = document;
  const text = normalizeText(input.text);
  const kind = input.kind === undefined ? 'daily' : input.kind;
  validateTaskTimes(kind, input, true);
  const longterm = kind === 'longterm';
  const plannedDate = normalizeOptionalDate(longterm ? input.startDate : input.plannedDate, longterm ? '起始日' : '计划日');
  const dueDate = normalizeOptionalDate(longterm ? input.endDate : input.dueDate, longterm ? '终止日' : '截止日');
  const recurrence = normalizeRecurrence(input.recurrence, null);
  const checked = normalizeChecked(input.checked, false);
  const completedDate = checked ? normalizeRequiredDate(completedOn, "完成日") : null;
  const taskLine = formatTaskLine({ indent: '', kind, checked, text, plannedDate, dueDate, recurrence, completedDate });
  let insertAt;
  if (longterm) {
    const heading = lines.findIndex(line => /^#{1,6}\s+持续工作\s*$/.test(line));
    if (heading >= 0) insertAt = heading + 1;
    else {
      if (lines.at(-1) === '') lines.pop();
      if (lines.length && lines.at(-1) !== '') lines.push('');
      lines.push('# 持续工作');
      insertAt = lines.length;
    }
  } else {
    insertAt = lines.findIndex(line => /^#{1,6}\s+(?:循环任务|持续工作)\s*$/.test(line));
    if (insertAt < 0) insertAt = lines.at(-1) === '' ? lines.length - 1 : lines.length;
    else if (insertAt > 0 && lines[insertAt - 1] === '') insertAt -= 1;
  }
  lines.splice(insertAt, 0, taskLine);

  return joinMarkdown(document);
}

function formatTaskLine({ indent, kind, checked, text, plannedDate, dueDate, recurrence, completedDate }) {
  const markers = [
    plannedDate ? `⏳ ${plannedDate}` : "",
    dueDate ? `📅 ${dueDate}` : "",
    completedDate ? `✅ ${completedDate}` : "",
  ].filter(Boolean);
  const recurrenceMarker = recurrence ? ` 🔁 every ${recurrence}` : "";
  return `${indent || ""}- [${checked ? "x" : " "}] ${text.replace(/\n/g, "<br>")}${recurrenceMarker}${markers.length ? ` ${markers.join(" ")}` : ""} <!-- baodan:kind=${kind} -->`;
}

function normalizeText(value) {
  // Keep each task on one physical Markdown line; formatTaskLine encodes breaks.
  const text = String(value ?? "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").trim();
  if (!text) throw fault(400, "事项内容不能为空");
  if (text.length > 500) throw fault(400, "事项内容不能超过500个字符");
  if (/^(?:-|#)\s/.test(text)) throw fault(400, "事项内容不能以 Markdown 列表或标题标记开头");
  readTaskKind(text);
  const normalized = stripTaskKind(text)
    .replace(/(?:⏳|📅|✅)\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/🔁\s*every\s+(?:day|week|month|year)/gi, "")
    .replace(/[^\S\n]+/g, " ")
    .split("\n").map((line) => line.trimEnd()).join("\n")
    .trim();
  if (!normalized) throw fault(400, "事项内容不能为空");
  return normalized;
}

function normalizeOptionalDate(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return normalizeRequiredDate(value, label);
}

function normalizeRequiredDate(value, label) {
  const date = String(value || "");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!DATE_PATTERN.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw fault(400, `${label}格式不正确`);
  }
  return date;
}

function normalizeRecurrence(value, fallback) {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  if (!RECURRENCES.has(value)) throw fault(400, "循环频率不正确");
  return value;
}

function normalizeChecked(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw fault(400, "完成状态必须是布尔值");
  return value;
}

function indentWidth(value) {
  return value.replace(/\t/g, "    ").length;
}

function splitMarkdown(markdown) {
  const hadBom = markdown.startsWith("\uFEFF");
  const content = hadBom ? markdown.slice(1) : markdown;
  return {
    lines: content ? content.split(/\r?\n/) : [],
    newline: content.includes("\r\n") ? "\r\n" : "\n",
    hadFinalNewline: /\r?\n$/.test(content),
    hadBom,
  };
}

function joinMarkdown(document) {
  let content = document.lines.join(document.newline);
  if (document.hadFinalNewline && !content.endsWith(document.newline)) content += document.newline;
  return `${document.hadBom ? "\uFEFF" : ""}${content}`;
}

