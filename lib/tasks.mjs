import { createHash } from "node:crypto";

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
    const recurrenceMatch = rawText.match(/🔁\s*every\s+(day|week|month|year)|(?:^|\s)(每天|每周|每月|每年)(?:\s|$)/i);
    const recurrence = recurrenceMatch
      ? recurrenceMatch[1]?.toLowerCase() || ({ 每天: "day", 每周: "week", 每月: "month", 每年: "year" })[recurrenceMatch[2]]
      : null;
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
      plannedDate,
      dueDate,
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
  return text
    .replace(/(?:⏳|📅|✅)\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/🔁\s*every\s+(?:day|week|month|year)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTaskText(text) {
  return text
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
    .replace(/(?:⏳|📅|✅)\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/🔁\s*every\s+(?:day|week|month|year)/gi, "")
    .replace(/~~/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildDashboard(tasks, options = {}) {
  const today = options.today || localDateString();
  const month = options.month || today.slice(0, 7);
  const eventMap = new Map();

  for (const task of tasks) {
    if (task.cancelled) continue;
    const datedRoles = [
      [task.plannedDate, "planned"],
      [task.dueDate, "due"],
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
      existing.overdue = !task.checked && !task.conflict && Boolean(task.dueDate) && task.dueDate < today;
      eventMap.set(key, existing);
    }
  }

  const overdue = tasks
    .filter((task) => isOverdue(task, today))
    .map((task) => {
      const anchorDate = task.dueDate || task.plannedDate;
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
    if (task.plannedDate && task.dueDate && task.plannedDate <= task.dueDate && validDate(task.plannedDate) && validDate(task.dueDate)) {
      const start = task.plannedDate < monthStart ? monthStart : task.plannedDate;
      const end = task.dueDate > monthEnd ? monthEnd : task.dueDate;
      if (start <= end) {
        const cursor = new Date(`${start}T00:00:00Z`);
        while (utcDateString(cursor) <= end) {
          add(utcDateString(cursor), task.id);
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
      }
    } else {
      add(task.plannedDate, task.id);
      add(task.dueDate, task.id);
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
    if (task.plannedDate === date) roles.push("planned");
    if (task.dueDate === date) roles.push("due");
    if (task.completedDate === date) roles.push("completed");
    if (
      !task.checked &&
      task.plannedDate &&
      task.dueDate &&
      task.plannedDate < date &&
      date < task.dueDate
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
  if (task.dueDate) return task.dueDate < today;
  return Boolean(task.plannedDate && task.plannedDate < today);
}

function isLongTerm(task) {
  if (task.checked || task.cancelled || task.conflict) return false;
  const section = task.headingPath.join("/");
  return Boolean(task.recurrence || /循环任务|无DL工作|长期工作|长期规划/.test(section));
}

function dayDifference(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.max(0, Math.floor((end - start) / 86400000));
}

function utcDateString(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
