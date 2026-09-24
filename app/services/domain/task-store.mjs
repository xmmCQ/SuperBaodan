import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseWorkTodo, localDateString } from './tasks.mjs';
import { addTaskMarkdown, deleteTaskMarkdown, moveTaskDateMarkdown, updateTaskMarkdown } from './task-writer.mjs';
import { fault } from '../../shared/errors.js';
import { createVersionedReader } from '../versioned-reader.mjs';

export class TaskStore {
  constructor({ todoFile, backupDir }) {
    this.todoFile = todoFile;
    this.backupDir = backupDir;
    this.lastGoodSource = null;
    this.reader = createVersionedReader(todoFile, parseWorkTodo);
    this.taskMutationQueue = Promise.resolve();
  }

  whenIdle() { return this.taskMutationQueue; }

  async loadTasks() {
    try {
      const {value:tasks,stat:fileStat} = await this.reader.read();
      const result = { tasks, updatedAt: fileStat.mtime.toISOString(), stale: false, warning: null };
      this.lastGoodSource = result;
      return structuredClone(result);
    } catch (error) {
      if (this.lastGoodSource) return { ...structuredClone(this.lastGoodSource), stale: true, warning: `读取最新待办失败，当前展示上次数据：${error.message}` };
      throw fault(500, `无法读取工作待办：${error.message}`);
    }
  }

  mutateTask(kind, revision, taskId, body) {
    const transforms = {
      create: (content) => addTaskMarkdown(content, body, localDateString()),
      update: (content) => updateTaskMarkdown(content, taskId, body, localDateString()),
      move: (content) => moveTaskDateMarkdown(content, taskId, body.sourceDate, body.targetDate),
      delete: (content) => deleteTaskMarkdown(content, taskId),
    };
    return this.mutateTodoFile(revision, content => {
      if ((kind === 'move' || kind === 'delete') && body.kind !== undefined) {
        const task = parseWorkTodo(content).find(item => item.id === taskId);
        if (task && body.kind !== task.kind) throw fault(400, '不能通过操作变更事项类型');
      }
      return transforms[kind](content);
    });
  }

  async mutateTodoFile(revision, transform) {
    const operation = async () => {
      const [original, fileStat] = await Promise.all([readFile(this.todoFile, "utf8"), stat(this.todoFile)]);
      const currentRevision = fileStat.mtime.toISOString();
      if (!revision) throw fault(400, "缺少源文件版本，请刷新页面后重试");
      if (revision !== currentRevision) throw fault(409, "工作待办已在其他位置更新，请刷新后重新操作");
      const nextContent = transform(original);
      if (nextContent === original) return { updatedAt: currentRevision };
      const nextTasks = parseWorkTodo(nextContent);
      this.reader.invalidate();
      try { await this.persistTodoFile(original, nextContent); }
      finally { this.reader.invalidate(); }
      const nextStat = await stat(this.todoFile);
      this.lastGoodSource = { tasks: nextTasks, updatedAt: nextStat.mtime.toISOString(), stale: false, warning: null };
      return { updatedAt: nextStat.mtime.toISOString() };
    };
    const queued = this.taskMutationQueue.then(operation);
    this.taskMutationQueue = queued.catch(() => {});
    return queued;
  }

  async persistTodoFile(original, nextContent) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(this.backupDir, `工作待办-${stamp}.md`);
    const tempPath = `${this.todoFile}.super-baodan-${process.pid}-${Date.now()}.tmp`;
    await writeFile(backupPath, original, "utf8");
    try { await writeFile(tempPath, nextContent, "utf8"); await rename(tempPath, this.todoFile); }
    catch (error) { await unlink(tempPath).catch(() => {}); throw fault(500, `写入工作待办失败，原文件已备份：${error.message}`); }
    this.trimTaskBackups().catch((error) => console.warn("清理待办备份失败：", error.message));
  }

  async trimTaskBackups() {
    const files = (await readdir(this.backupDir)).filter((name) => name.startsWith("工作待办-") && name.endsWith(".md")).sort().reverse();
    await Promise.all(files.slice(30).map((name) => unlink(path.join(this.backupDir, name)).catch(() => {})));
  }

}
