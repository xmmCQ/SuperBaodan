import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestQuery } from '../app/renderer/core/latest-query.js';
import { createModelCatalogSync } from '../app/renderer/core/model-catalog-sync.js';
import { registerWorkspaceCommands } from '../app/services/commands/workspaces.mjs';

test('两种搜索共用取消/代次校验，清空、换工作区和迟到响应不发布',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let query='A',scope='one';const calls=[],shown=[];
  const search=createLatestQuery({query:()=>query,scope:()=>scope,clear(){},request:(q,signal)=>new Promise((resolve,reject)=>calls.push({q,signal,resolve,reject})),publish:data=>shown.push(data)});
  const a=search.run();query='B';const b=search.run();assert.equal(calls[0].signal.aborted,true);
  calls[1].resolve('B');await b;calls[0].resolve('A');await a;assert.deepEqual(shown,['B']);
  query='C';const c=search.run();query='';await search.run();calls[2].resolve('C');await c;assert.deepEqual(shown,['B']);
  query='D';search.run(120);query='E';search.run(120);t.mock.timers.tick(120);assert.equal(calls.at(-1).q,'E');
  scope='two';calls.at(-1).resolve('old scope');await Promise.resolve();await Promise.resolve();assert.deepEqual(shown,['B']);search.cancel();
});
test('文件搜索命令将同一个取消信号交给扫描器',async()=>{
  const commands=new Map();registerWorkspaceCommands(commands);const controller=new AbortController();let received;
  const context={assertActiveWorkspace(){},workspaceService:{search:async(q,options)=>{received=options.signal;assert.equal(q,'query');return[];}}};
  await commands.get('files.search')({q:'query'},context,controller.signal);assert.equal(received,controller.signal);
});
test('目录事件完整结果零读取，旧格式并发只读一次，旧请求不能覆盖操作结果',async()=>{
  let count=0,release,scope='A',epoch=0;const delivered=[];
  const sync=createModelCatalogSync({scope:()=>scope,capture:()=>{const value=epoch;return()=>value===epoch;},read:()=>{count++;return new Promise(r=>release=r);},apply:data=>delivered.push(data),onError:error=>{throw error;}});
  await sync.receive({catalog:'direct',workspaceId:'A'});assert.equal(count,0);
  const a=sync.receive({}),b=sync.receive({});assert.equal(count,1);
  await sync.receive({catalog:'saved',workspaceId:'A'});release('old');await Promise.all([a,b]);assert.deepEqual(delivered,['direct','saved']);
  const c=sync.receive({});scope='B';release('workspace A');await c;assert.deepEqual(delivered,['direct','saved']);
  const old=sync.receive({}),oldRelease=release;epoch++;scope='A';epoch++;scope='B';const fresh=sync.receive({});
  oldRelease('old B');release('fresh B');await Promise.all([old,fresh]);assert.deepEqual(delivered,['direct','saved','fresh B']);
});
