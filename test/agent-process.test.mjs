import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { processPair, until } from './helpers/process-pair.mjs';

function event(service,type) {return new Promise(resolve=>{const listener=message=>{if(message.event.type===type){service.off('event',listener);resolve(message.event);}};service.on('event',listener);});}
test('最小隔离：Agent同步阻塞2秒，本地先返回，解除后Agent可用，结束后本地仍可读', {timeout:25000},async t=>{
  const f=await processPair(t);await f.service.invoke('agent.start');
  const began=event(f.service,'fixture_block');let complete=false;
  const blocking=f.service.invoke('models.catalog',{fixture:'block',blockMs:2000}).then(()=>{complete=true;});await began;
  const times={};
  for(const [name,args] of [['tasks.day',{id:'2026-09-04'}],['records.list',{date:'2026-09-04'}]]){
    const start=performance.now();await f.service.invoke(name,args);times[name]=performance.now()-start;assert.equal(complete,false);
  }
  t.diagnostic(JSON.stringify(times));await blocking;
  assert.equal((await f.service.invoke('models.catalog',{})).ok,true);
  assert.equal(await f.agent.stop(3000),true);
  assert.ok((await f.service.invoke('tasks.day',{id:'2026-09-04'})).tasks);
  assert.ok(Array.isArray((await f.service.invoke('records.list',{date:'2026-09-04'})).records));
});
test('96个Agent请求占用时保留本地容量，取消控制不排队', {timeout:25000},async t=>{
  const f=await processPair(t);await f.service.invoke('agent.start');
  let held=0;f.service.on('event',message=>{if(message.event.type==='fixture_held')held=message.event.count;});
  const requests=Array.from({length:96},()=>f.service.invoke('models.catalog',{fixture:'hold'}));await until(()=>held===96);
  await assert.rejects(f.service.invoke('models.catalog',{}),e=>e.statusCode===429);
  const start=performance.now();await f.service.invoke('tasks.day',{id:'2026-09-04'});assert.ok(performance.now()-start<500);
  await f.service.invoke('auth.cancel',{});await Promise.all(requests);
});
test('Agent崩溃后本地CRUD可用，不自动重启；显式重试才产生新代次', {timeout:25000},async t=>{
  const f=await processPair(t);await f.service.invoke('agent.start');const old=f.agent.currentRun.id;
  await assert.rejects(f.service.invoke('models.catalog',{fixture:'crash'}),/断开|未知/);await until(()=>f.agent.currentRun===null);
  const first=await f.service.invoke('tasks.day',{id:'2026-09-04'});
  await f.service.invoke('tasks.create',{revision:first.updatedAt,kind:'daily',text:'崩溃期间的本地工作',plannedDate:'2026-09-04'});
  assert.ok((await f.service.invoke('tasks.day',{id:'2026-09-04'})).tasks.some(task=>task.text==='崩溃期间的本地工作'));
  assert.equal((await f.service.invoke('agent.receipt',{requestId:'unknown'})).status,'unknown');
  await assert.rejects(f.service.invoke('agent.start'),/重试|断开/);assert.equal(f.agent.currentRun,null);
  await f.service.invoke('agent.start',{retry:true});assert.notEqual(f.agent.currentRun.id,old);
});
test('SDK缺失只影响助手，状态查询和本地数据不触发同进程SDK回退', {timeout:25000},async t=>{
  const f=await processPair(t,{agentEntry:path.resolve('app/agent/main.mjs'),piPackagePath:path.resolve('test/nonexistent-sdk')});
  await assert.rejects(f.service.invoke('agent.start'),/SDK|Pi/);
  const status=await f.service.invoke('system.status');assert.equal(status.assistantInstalled,false);assert.equal(status.assistantState,'error');
  assert.ok((await f.service.invoke('tasks.dashboard')).today);
  assert.ok(Array.isArray((await f.service.invoke('records.list',{date:'2026-09-04'})).records));
});
