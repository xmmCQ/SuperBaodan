import test from 'node:test';
import assert from 'node:assert/strict';
import { createDayLoader } from '../app/renderer/home/day-loader.js';

function fixture(t) {
  t.mock.timers.enable({apis:['setTimeout']});
  const requests=[],commits=[],notices=[],locks=[];
  const prepare=(kind,date)=>new Promise((resolve,reject)=>requests.push({kind,date,reject,resolve:()=>resolve({current:()=>true,fresh:true,commit:()=>commits.push(`${kind}:${date}`)})}));
  const load=createDayLoader({prepareTasks:date=>prepare('tasks',date),prepareRecords:date=>prepare('records',date),commitDate:date=>commits.push(`title:${date}`),setLoading:v=>locks.push(v),showNotice:(text,retry)=>notices.push({text,retry}),retry:date=>load(date)});
  return {load,requests,commits,notices,locks};
}
test('两类数据均返回后同轮提交，慢请求才提示，快请求无提示闪烁', async t=>{
  const f=fixture(t),loading=f.load('A');
  f.requests[0].resolve();await Promise.resolve();
  assert.deepEqual(f.commits,[]);t.mock.timers.tick(299);assert.equal(f.notices.at(-1).text,'');
  t.mock.timers.tick(1);assert.equal(f.notices.at(-1).text,'正在读取…');
  f.requests[1].resolve();assert.equal(await loading,true);
  assert.deepEqual(f.commits,['tasks:A','records:A','title:A']);assert.equal(f.locks.at(-1),false);assert.equal(f.notices.at(-1).text,'');
  const fast=f.load('B');f.requests[2].resolve();f.requests[3].resolve();await fast;
  const count=f.notices.length;t.mock.timers.tick(1000);assert.equal(f.notices.length,count);
});
test('A→B→A连续切换只提交最后一轮，过期失败不提示、不解锁', async t=>{
  const f=fixture(t),first=f.load('A'),second=f.load('B'),last=f.load('A');
  f.requests[0].resolve();f.requests[1].resolve();await first;
  f.requests[2].reject(new Error('过期错误'));await second;
  assert.deepEqual(f.commits,[]);assert.equal(f.locks.at(-1),true);assert.ok(f.notices.every(n=>!n.text.includes('错误')));
  f.requests[4].resolve();f.requests[5].resolve();await last;
  f.requests[3].resolve();await Promise.resolve();
  assert.deepEqual(f.commits,['tasks:A','records:A','title:A']);assert.equal(f.locks.filter(v=>!v).length,1);
});
test('失败保留已展示内容，迟到成功不提交，可重试', async t=>{
  const f=fixture(t),failed=f.load('B');f.requests[0].reject(new Error('读取失败'));
  assert.equal(await failed,false);assert.deepEqual(f.commits,[]);assert.equal(f.locks.at(-1),false);
  f.requests[1].resolve();await Promise.resolve();assert.deepEqual(f.commits,[]);
  const retry=f.notices.at(-1).retry();f.requests[2].resolve();f.requests[3].resolve();await retry;
  assert.deepEqual(f.commits,['tasks:B','records:B','title:B']);assert.equal(f.notices.at(-1).text,'');
});
