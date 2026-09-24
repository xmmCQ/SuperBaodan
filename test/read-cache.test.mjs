import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, writeFile, utimes } from 'node:fs/promises';
import { createVersionedReader } from '../app/services/versioned-reader.mjs';
import { TaskStore } from '../app/services/domain/task-store.mjs';
import { DailyRecordManager } from '../app/services/domain/daily-record-manager.mjs';
import { WorkspaceService } from '../app/services/domain/workspace.mjs';
import { createTempProject } from './helpers/temp-project.mjs';

test('同版只解析一次、并发合并；外部同大小且恢复mtime的修改仍失效',async t=>{
  const temp=await createTempProject('version-cache-');t.after(temp.cleanup);const file=await temp.write('data.json','{"value":1}');let parses=0;
  const reader=createVersionedReader(file,text=>{parses++;return JSON.parse(text);});
  const values=await Promise.all(Array.from({length:8},()=>reader.read()));assert.equal(parses,1);assert.ok(values.every(v=>v===values[0]));await reader.read();assert.equal(parses,1);
  const before=await stat(file);await writeFile(file,'{"value":2}');await utimes(file,before.atime,before.mtime);
  assert.equal((await reader.read()).value.value,2);assert.equal(parses,2);
  const pending=reader.read();reader.invalidate();await pending;assert.equal(parses,3);
  await writeFile(file,'broken');await assert.rejects(reader.read());await writeFile(file,'{"value":3}');assert.equal((await reader.read()).value.value,3);
});
test('管理器不泄露缓存引用，写入后立即可见，损坏时保留既有错误行为',async t=>{
  const temp=await createTempProject('store-cache-');t.after(temp.cleanup);const backupDir=await temp.ensureDir('backups');
  const todoFile=await temp.write('todo.md','- [ ] 原事项\n');const store=new TaskStore({todoFile,backupDir});
  const first=await store.loadTasks();first.tasks[0].text='不能污染缓存';assert.equal((await store.loadTasks()).tasks[0].text,'原事项');
  await store.mutateTask('create',first.updatedAt,null,{kind:'longterm',text:'新增'});assert.equal((await store.loadTasks()).tasks.length,2);
  const manager=new DailyRecordManager({filePath:temp.resolve('records.json'),backupDir});await manager.initialize();
  const reads=[];const read=manager.reader.read;manager.reader.read=()=>{const pending=read();reads.push(pending);return pending;};
  await Promise.all([manager.listByDate('2026-09-04'),manager.monthSummary('2026-09')]);assert.equal(reads.length,2);assert.equal(reads[0],reads[1]);
  const item=await manager.create({date:'2026-09-04',title:'记录',type:'work',time:'',content:'原文'});
  const snapshot=await manager.readStore();snapshot.items[0].title='不能污染';assert.equal((await manager.readStore()).items[0].title,'记录');
  await manager.update(item.id,{revision:item.updatedAt,title:'新标题',type:'work',time:'',content:'新正文'});assert.equal((await manager.readStore()).items[0].title,'新标题');
  await writeFile(manager.filePath,'{}');await assert.rejects(manager.readStore(),/读取失败/);
});
test('单个大目录严格遵守5000项预算，扫描中取消会关闭目录',async t=>{
  const temp=await createTempProject('search-budget-');t.after(temp.cleanup);let reads=0,closed=0;
  const controller=new AbortController();let abortAt=Infinity;
  const service=await new WorkspaceService(temp.root,{openDirectory:async()=>({read:async()=>{reads++;if(reads===abortAt)controller.abort();return {name:'unmatched',isSymbolicLink:()=>false,isDirectory:()=>false,isFile:()=>false};},close:async()=>{closed++;}})}).initialize();
  await service.search('needle');assert.equal(reads,5000);assert.equal(closed,1);
  reads=0;abortAt=3;await assert.rejects(service.search('needle',{signal:controller.signal}),e=>e.statusCode===499);assert.equal(reads,3);assert.equal(closed,2);
});
