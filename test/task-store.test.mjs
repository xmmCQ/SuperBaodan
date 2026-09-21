import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, unlink, utimes } from 'node:fs/promises';
import { TaskStore } from '../app/services/domain/task-store.mjs';
import { createRuntimeContext } from '../app/services/runtime-context.mjs';
import { createTempProject } from './helpers/temp-project.mjs';

test('待办存储保留版本冲突、备份、最近有效数据以及队列等待', async t => {
  const temp = await createTempProject('task-store-'); t.after(temp.cleanup);
  const todoFile = await temp.write('todo.md', '- [ ] 原任务\n'), backupDir = await temp.ensureDir('backups');
  await utimes(todoFile, new Date('2020-01-01'), new Date('2020-01-01'));
  const store = new TaskStore({ todoFile, backupDir });
  const first = await store.loadTasks(); assert.equal(first.stale, false);
  let release, entered;
  const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const persist = store.persistTodoFile.bind(store);
  store.persistTodoFile = async (...args) => { entered(); await gate; return persist(...args); };
  const writing = store.mutateTodoFile(first.updatedAt, text => text + '- [ ] 新任务\n');
  await started;
  let idle = false; const draining = store.whenIdle().then(() => { idle = true; });
  await new Promise(setImmediate); assert.equal(idle, false);
  const stale = assert.rejects(store.mutateTodoFile(first.updatedAt, text => text + 'bad'), { statusCode: 409 });
  release(); await writing; await draining; await stale;
  assert.equal((await store.loadTasks()).tasks.length, 2);
  const files = await readdir(backupDir); assert.equal(files.length, 1);
  assert.equal(await readFile(`${backupDir}/${files[0]}`, 'utf8'), '- [ ] 原任务\n');
  await unlink(todoFile); const cached = await store.loadTasks();
  assert.equal(cached.stale, true); assert.equal(cached.tasks.length, 2); assert.match(cached.warning, /读取最新待办失败/);
  await store.trimTaskBackups();
});

test('无时间持续工作持久化、重读与revision冲突不丢数据', async t => {
  const temp = await createTempProject('task-store-longterm-'); t.after(temp.cleanup);
  const todoFile = await temp.write('todo.md', '\ufeff# 工作\r\n- [ ] 原事项 📅 2026-09-01\r\n'), backupDir = await temp.ensureDir('backups');
  await utimes(todoFile, new Date('2020-01-01'), new Date('2020-01-01'));
  const store = new TaskStore({ todoFile, backupDir }); const first = await store.loadTasks();
  await store.mutateTask('create', first.updatedAt, null, { kind: 'longterm', text: '无时间持续' });
  const persisted = await readFile(todoFile, 'utf8');
  const reopened = await new TaskStore({ todoFile, backupDir }).loadTasks();
  assert.equal(reopened.tasks[1].kind, 'longterm'); assert.equal(reopened.tasks[1].startDate, null);
  await assert.rejects(store.mutateTask('create', first.updatedAt, null, { kind: 'longterm', text: '冲突写入' }), { statusCode: 409 });
  assert.equal(await readFile(todoFile, 'utf8'), persisted);
  await assert.rejects(store.mutateTodoFile(reopened.updatedAt, text => text + '- [ ] 异常 <!-- baodan:kind=unknown -->\r\n'), { statusCode: 400 });
  assert.equal(await readFile(todoFile, 'utf8'), persisted);
  assert.equal((await readdir(backupDir)).length, 1);
  assert.ok(persisted.startsWith('\ufeff# 工作\r\n- [ ] 原事项 📅 2026-09-01\r\n'));
});

test('RuntimeContext退出等待TaskStore中已受理的写入', async t => {
  const temp = await createTempProject('task-store-shutdown-');
  const context = await createRuntimeContext({ todoFile: await temp.write('todo.md', '- [ ] 原任务\n'), backupDir: temp.resolve('backups'), workspaceDir: temp.resolve('workspace'), workspaceFile: temp.resolve('workspaces.json'), piAgentDir: temp.resolve('agent'), piSessionDir: temp.resolve('sessions'), vskillFile: temp.resolve('vskills.json'), dailyRecordFile: temp.resolve('records.json') });
  let release; const gate = new Promise(r => { release = r; });
  t.after(async () => { release(); await context.shutdown(); await temp.cleanup(); });
  let drained = false; context.taskStore.whenIdle = async () => { await gate; drained = true; };
  let exited = false; const shutdown = context.shutdown().then(() => { exited = true; });
  await new Promise(setImmediate); assert.equal(exited, false);
  release(); await shutdown; assert.equal(drained, true);
});
