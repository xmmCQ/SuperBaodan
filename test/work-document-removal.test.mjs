import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkDocuments } from '../lib/work-documents.mjs';
import { recycleWorkDocument } from '../lib/recycle-work-document.mjs';

test('删除入口与回收源文件分离，冲突/失败不丢入口', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baodan-removal-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const file = path.join(root, '资料.txt'); await fs.writeFile(file, '保留内容');
  let calls = 0, error = false;
  const manager = new WorkDocuments({ filePath:path.join(root,'catalog.json'), recycle:async target => { calls++; if(error) throw new Error('recycle failed'); await fs.rename(target, path.join(root,'recycled.txt')); } });
  const put = async kind => { const data=await manager.read();return manager.save({...data,documents:[{id:'doc',name:'资料',categoryId:'uncategorized',kind,target:kind==='file'?file:'https://example.com/doc'}]}); };
  let data = await put('file');
  await manager.remove({id:'doc',revision:data.revision,recycleSource:false});
  assert.equal(await fs.readFile(file,'utf8'),'保留内容'); assert.equal(calls,0);
  data = await put('file');
  await assert.rejects(manager.remove({id:'doc',revision:'stale',recycleSource:true}), /目录已变化/);
  assert.equal(calls,0);
  error=true;
  await assert.rejects(manager.remove({id:'doc',revision:data.revision,recycleSource:true}), /recycle failed/);
  assert.equal((await manager.read()).documents.length,1);
  error=false;
  const result=await manager.remove({id:'doc',revision:data.revision,recycleSource:true});
  assert.equal(result.recycled,true); assert.equal(result.documents.length,0);
  assert.equal(await fs.readFile(path.join(root,'recycled.txt'),'utf8'),'保留内容');
  data=await put('url');const before=calls;
  await manager.remove({id:'doc',revision:data.revision,recycleSource:true}); assert.equal(calls,before);
  data=await put('file');
  await assert.rejects(manager.remove({id:'doc',revision:data.revision,recycleSource:true}), /源文件不存在/);
  assert.equal((await manager.read()).documents.length,1);
});

test('Windows 回收适配器只传固定脚本和路径参数，不降级为永久删除', async t => {
  if(process.platform!=='win32') return t.skip('Windows only');
  let captured;
  await recycleWorkDocument('C:\\测试\\a.txt', async (...args)=>{captured=args;return {stdout:''};});
  assert.equal(captured[2].env.SUPERBAODAN_RECYCLE_TARGET,'C:\\测试\\a.txt');
  const script=Buffer.from(captured[1].at(-1),'base64').toString('utf16le');
  assert.ok(script.includes('0x00080000'));
  assert.equal(script.includes('C:\\测试\\a.txt'),false);
  await assert.rejects(recycleWorkDocument('C:\\x.txt',async()=>{throw new Error('failure');}),/不会改为永久删除/);
});
