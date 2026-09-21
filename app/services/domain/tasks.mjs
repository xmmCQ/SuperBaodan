import { createHash } from "node:crypto";
import { readTaskKind, stripTaskKind, taskKind, taskDates } from '../../shared/task-fields.js';

const DATE_RE = /\d{4}-\d{2}-\d{2}/;

export function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseWorkTodo(markdown) {
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headings = [];
  const taskStack = [];
  const tasks = [];

  lines.forEach((line, index) => {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      headings[level - 1] = headingMatch[2].trim();
      headings.length = level;
      taskStack.length = 0;
      return;
    }

    const taskMatch = line.match(/^(\s*)-\s+\[([ xX])\]\s*(.+?)\s*$/);
    if (!taskMatch) return;

    const indent = taskMatch[1].replace(/\t/g, "    ").length;
    const checked = taskMatch[2].toLowerCase() === "x";
    const rawText = taskMatch[3].trim();

    while (taskStack.length && taskStack.at(-1).indent >= indent) taskStack.pop();
    const parentTasks = taskStack.map((entry) => entry.text);

    const plannedDate = markerDate(rawText, "⏳");
    const dueDate = markerDate(rawText, "📅");
    const completedDate = markerDate(rawText, "✅");
    const explicitKind = readTaskKind(rawText);
    const recurrenceMatch = rawText.match(explicitKind ? /🔁\s*every\s+(day|week|month|year)/i : /🔁\s*every\s+(day|week|month|year)|(?:^|\s)(每天|每周|每月|每年)(?:\s|$)/i);
    const recurrence = recurrenceMatch
      ? recurrenceMatch[1]?.toLowerCase() || ({ 每天: "day", 每周: "week", 每月: "month", 每年: "year" })[recurrenceMatch[2]]
      : null;
    const kind = taskKind({ kind: explicitKind, recurrence, headingPath: headings.filter(Boolean) });
    const cancelled = /~~.+~~|暂缓/.test(rawText);
    const conflict = !checked && Boolean(completedDate);
    const text = cleanTaskText(rawText);
    const editableText = editableTaskText(rawText);
    const headingPath = headings.filter(Boolean);
    const id = createHash("sha1")
      .update(`${index + 1}|${headingPath.join("/")}|${rawText}`)
      .digest("hex")
      .slice(0, 12);

    const task = {
      id,
      text,
      editableText,
      rawText,
      checked,
      kind,
      ...(kind === 'longterm' ? { startDate: plannedDate, endDate: dueDate } : { plannedDate, dueDate }),
      completedDate,
      recurrence,
      cancelled,
      conflict,
      headingPath,
      parentTasks,
      sourceIndent: taskMatch[1],
      sourceLine: index + 1,
    };

    tasks.push(task);
    taskStack.push({ indent, text });
  });

  return tasks;
}

function markerDate(text, marker) {
  const match = text.match(new RegExp(`${marker}\\s*(${DATE_RE.source})`));
  return match ? match[1] : null;
}

function editableTaskText(text) {
  return stripTaskKind(text)
    .replace(/(?:⏳|📅|✅)\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/🔁\s*every\s+(?:day|week|month|year)/gi, "")
    .replace(/\s+/g, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .trim();
}

function cleanTaskText(text) {
  return stripTaskKind(text)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
    .replace(/(?:⏳|📅|✅)\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/🔁\s*every\s+(?:day|week|month|year)/gi, "")
    .replace(/~~/g, "")
    .replace(/\s+/g, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .trim();
}

export function buildDashboard(tasks, options = {}) {
  const today = options.today || localDateString();
  const month = options.month || today.slice(0, 7);
  const eventMap = new Map();

  for (const task of tasks) {
    if (task.cancelled) continue;
    const { plannedDate, dueDate } = taskDates(task);
    const datedRoles = [
      [plannedDate, 'planned'],
      [dueDate, 'due'],
      [task.completedDate, "completed"],
    ];

    for (const [date, role] of datedRoles) {
      if (!date || !date.startsWith(`${month}-`)) continue;
      const key = `${task.id}|${date}`;
      const existing = eventMap.get(key) || {
        taskId: task.id,
        date,
        text: task.text,
        checked: task.checked,
        conflict: task.conflict,
        roles: [],
      };
      if (!existing.roles.includes(role)) existing.roles.push(role);
      existing.overdue = !task.checked && !task.conflict && Boolean(dueDate) && dueDate < today;
      eventMap.set(key, existing);
    }
  }

  const overdue = tasks
    .filter((task) => isOverdue(task, today))
    .map((task) => {
      const dates = taskDates(task);
      const anchorDate = dates.dueDate || dates.plannedDate;
      return { ...task, anchorDate, overdueDays: dayDifference(anchorDate, today) };
    })
    .sort((a, b) => b.overdueDays - a.overdueDays || a.anchorDate.localeCompare(b.anchorDate));

  const longTerm = tasks
    .filter((task) => isLongTerm(task))
    .sort((a, b) => {
      if (a.recurrence && !b.recurrence) return -1;
      if (!a.recurrence && b.recurrence) return 1;
      return a.sourceLine - b.sourceLine;
    });

  const calendarEvents = [...eventMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const eventsByDate = new Map();
  for (const event of calendarEvents) {
    const dayEvents = eventsByDate.get(event.date) || [];
    dayEvents.push(event);
    eventsByDate.set(event.date, dayEvents);
  }
  for (const dayEvents of eventsByDate.values()) {
    if (dayEvents.length && dayEvents.every((event) => event.checked)) {
      for (const event of dayEvents) {
        event.roles = ["completed"];
        event.overdue = false;
      }
    }
  }

  return {
    today,
    month,
    events: calendarEvents,
    pendingByDate: buildPendingByDate(tasks, month),
    overdue,
    longTerm,
    counts: {
      total: tasks.length,
      unfinished: tasks.filter((task) => !task.checked && !task.cancelled).length,
      overdue: overdue.length,
      longTerm: longTerm.length,
    },
  };
}

function buildPendingByDate(tasks, month) {
  const pending = new Map();
  const [year, monthNumber] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = utcDateString(new Date(Date.UTC(year, monthNumber, 0)));

  const add = (date, taskId) => {
    if (!date || date < monthStart || date > monthEnd) return;
    const taskIds = pending.get(date) || new Set();
    taskIds.add(taskId);
    pending.set(date, taskIds);
  };

  for (const task of tasks) {
    if (task.checked || task.cancelled || task.conflict) continue;
    const { plannedDate, dueDate } = taskDates(task);
    if (plannedDate && dueDate && plannedDate <= dueDate && validDate(plannedDate) && validDate(dueDate)) {
      const start = plannedDate < monthStart ? monthStart : plannedDate;
      const end = dueDate > monthEnd ? monthEnd : dueDate;
      if (start <= end) {
        const cursor = new Date(`${start}T00:00:00Z`);
        while (utcDateString(cursor) <= end) {
          add(utcDateString(cursor), task.id);
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
      }
    } else {
      add(plannedDate, task.id);
      add(dueDate, task.id);
    }
  }

  return Object.fromEntries(
    [...pending.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, taskIds]) => [date, taskIds.size]),
  );
}

function validDate(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function buildDayDetails(tasks, date) {
  const entries = [];

  for (const task of tasks) {
    if (task.cancelled) continue;
    const roles = [];
    const { plannedDate, dueDate } = taskDates(task);
    if (plannedDate === date) roles.push('planned');
    if (dueDate === date) roles.push('due');
    if (task.completedDate === date) roles.push("completed");
    if (
      !task.checked &&
      plannedDate &&
      dueDate &&
      plannedDate < date &&
      date < dueDate
    ) {
      roles.push("ongoing");
    }
    if (roles.length) entries.push({ ...task, roles });
  }

  return entries.sort((a, b) => rolePriority(a.roles) - rolePriority(b.roles) || a.sourceLine - b.sourceLine);
}

function rolePriority(roles) {
  if (roles.includes("due")) return 0;
  if (roles.includes("planned")) return 1;
  if (roles.includes("ongoing")) return 2;
  return 3;
}

function isOverdue(task, today) {
  if (task.checked || task.cancelled || task.conflict) return false;
  const { plannedDate, dueDate } = taskDates(task);
  if (dueDate) return dueDate < today;
  if (taskKind(task) === 'longterm') return false;
  return Boolean(plannedDate && plannedDate < today);
}

function isLongTerm(task) {
  if (task.checked || task.cancelled || task.conflict) return false;
  return taskKind(task) === 'longterm';
}

function dayDifference(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.max(0, Math.floor((end - start) / 86400000));
}

function utcDateString(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
