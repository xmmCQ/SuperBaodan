import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTestScreenshots } from './helpers/test-screenshots.mjs';

function context() {
  const diagnostics=[];
  return {name:'场景/不安全文件名',diagnostics,diagnostic:message=>diagnostics.push(message)};
}
function clean(t,file) { if(file)t.after(()=>rm(path.dirname(file),{recursive:true,force:true})); }

test('默认成功零截图、零诊断；off模式失败也不截图', async () => {
  let calls=0;const ctx=context(),browser={screenshot(){calls++;throw new Error('不应调用');}};
  const previous=process.env.SUPER_BAODAN_TEST_SCREENSHOTS;
  let shots;
  try { delete process.env.SUPER_BAODAN_TEST_SCREENSHOTS; shots=createTestScreenshots(ctx,()=>browser); }
  finally { if(previous===undefined)delete process.env.SUPER_BAODAN_TEST_SCREENSHOTS;else process.env.SUPER_BAODAN_TEST_SCREENSHOTS=previous; }
  assert.equal(await shots.shot('成功检查点'),null);assert.equal(await shots.finish(null),null);
  const off=createTestScreenshots(ctx,()=>browser,{mode:'off'});
  assert.equal(await off.finish(new Error('故意失败')),null);assert.equal(await off.shot('manual'),null);
  assert.equal(calls,0);assert.deepEqual(ctx.diagnostics,[]);
});

test('每个失败场景最多一张，限临时目录，重复/并发回调不追加', async t => {
  let calls=0;const ctx=context(),png=Buffer.from('fixture-image');
  const shots=createTestScreenshots(ctx,()=>({async screenshot(){calls++;return png;}}),{mode:'failure'});
  const error=new Error('原始断言失败');
  const files=await Promise.all([shots.finish(error),shots.finish(error)]);
  const file=files.find(Boolean);assert.ok(file);clean(t,file);
  assert.ok(path.resolve(file).startsWith(path.resolve(os.tmpdir())+path.sep));
  assert.equal(path.basename(file).includes('/'),false);
  assert.deepEqual(await readFile(file),png);
  assert.equal((await readdir(path.dirname(file))).length,1);
  assert.equal(await shots.finish(error),null);assert.equal(calls,1);assert.equal(ctx.diagnostics.length,1);
});

test('只有显式visual模式允许检查点图片；截图故障不替换原始失败', async t => {
  let calls=0;const ctx=context();
  const visual=createTestScreenshots(ctx,()=>({async screenshot(){calls++;return Buffer.from('manual');}}),{mode:'visual'});
  const file=await visual.shot('人工验收');assert.ok(file);clean(t,file);assert.equal(calls,1);
  const broken=createTestScreenshots(ctx,()=>({screenshot(){throw new Error('浏览器已退出');}}),{mode:'failure'});
  const original=new Error('原始错误');assert.equal(await broken.finish(original),null);assert.equal(original.message,'原始错误');
  assert.ok(ctx.diagnostics.some(message=>message.includes('浏览器已退出')));
  const slow=createTestScreenshots(ctx,()=>({screenshot:()=>new Promise(()=>{})}),{mode:'failure',timeout:10});
  assert.equal(await slow.finish(original),null);assert.ok(ctx.diagnostics.some(message=>message.includes('截图超时')));
  assert.equal(await createTestScreenshots(ctx,()=>null,{mode:'failure'}).finish(original),null);
});
