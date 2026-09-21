import test from 'node:test';
import assert from 'node:assert/strict';
import { reorderDocumentSlots } from '../app/renderer/home/work-document-sort.js';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './helpers/browser-harness.mjs';

test('排序仅改指定槽位，隐藏分类与其他分类文档不移动', () => {
  const items = ['a','hidden','b','c'].map(id=>({id}));
  assert.equal(reorderDocumentSlots(items,'c','a',false,x=>x.id!=='hidden'),true);
  assert.deepEqual(items.map(x=>x.id),['c','hidden','a','b']);
  assert.equal(reorderDocumentSlots(items,'c','c',true),false);
  assert.equal(reorderDocumentSlots(items,'hidden','a',true,x=>x.id!=='hidden'),false);
});

test('分类与文档拖柄排序持久化，搜索禁用，失败恢复', {timeout:30000}, async t => {
  if(!edgeAvailable()) return t.skip('需要 Edge');
  const fixture=await createSmokeServer();let browser;
  t.after(async()=>{await browser?.close();await fixture.close();});
  const initial=await fixture.state.workDocuments.read();
  await fixture.state.workDocuments.save({...initial,categories:[...initial.categories,{id:'a',name:'甲'},{id:'empty',name:'空'},{id:'b',name:'乙'}],documents:[
    {id:'a1',name:'甲一',categoryId:'a',kind:'url',target:'https://example.com/a1'},
    {id:'b1',name:'乙一',categoryId:'b',kind:'url',target:'https://example.com/b1'},
    {id:'a2',name:'甲二',categoryId:'a',kind:'url',target:'https://example.com/a2'},
    {id:'u',name:'无分类',categoryId:'uncategorized',kind:'url',target:'https://example.com/u'},
  ]});
  browser=await launchBrowser({width:1600,height:1000});
  await browser.navigate(`http://127.0.0.1:${fixture.port}/`);
  await browser.waitFor("document.documentElement.classList.contains('app-ready')");
  await browser.evaluate('workDocumentsButton.click()');
  await browser.waitFor("document.querySelectorAll('.wd-row').length===4 && !document.querySelector('.wd-row .wd-drag-handle').disabled");
  const drag=async(container,from,to,after=false)=>{
    const points = await browser.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(container)}),a=c.querySelector('[data-sort-id="${from}"] .wd-drag-handle').getBoundingClientRect(),b=c.querySelector('[data-sort-id="${to}"]').getBoundingClientRect();return {from:{x:a.left+a.width/2,y:a.top+a.height/2},to:{x:b.left+b.width/2,y:b.top+b.height*${after ? 0.75 : 0.25}}};})()`);
    await browser.dragPointer(points.from, points.to);
  };
  const acceptance = await browser.evaluate(`(()=>{
    const c=document.querySelector('.wd-list'), handle=c.querySelector('.wd-drag-handle'), dt=new DataTransfer(), r=c.getBoundingClientRect();
    handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));
    const results=[c,c.querySelector('.wd-doc-name'),c.querySelector('.wd-row-actions button')].map(node=>{
      const e=new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+10,clientY:r.top+10});node.dispatchEvent(e);return e.defaultPrevented && c.classList.contains('wd-sort-active');
    });
    c.dispatchEvent(new DragEvent('dragleave',{bubbles:true,dataTransfer:dt,clientX:r.right+100,clientY:r.bottom+100}));
    const outside=dt.dropEffect==='none';window.dispatchEvent(new Event('dragend'));
    return {inside:results.every(Boolean),outside,clean:!c.classList.contains('wd-sort-active')};
  })()`);
  assert.deepEqual(acceptance,{inside:true,outside:true,clean:true});
  await browser.evaluate("window.originalCategoryRows=[...document.querySelectorAll('.wd-category')]");
  await drag('.wd-categories','b','a');
  await browser.waitFor("document.querySelector('.wd-category[data-sort-id]').dataset.sortId==='b' && !document.querySelector('.wd-toolbar input').readOnly");
  assert.equal(await browser.evaluate("originalCategoryRows.every(row=>row.isConnected)"),true);
  assert.deepEqual((await fixture.state.workDocuments.read()).categories.map(x=>x.id),['uncategorized','b','empty','a']);
  assert.equal(await browser.evaluate("document.querySelector('.wd-category:last-of-type').textContent.includes('未分类')"),true);
  await browser.evaluate("document.querySelector('.wd-category[data-sort-id=a] > button:not(.wd-drag-handle)').click()");
  await drag('.wd-list','a2','a1');
  await browser.waitFor("document.querySelector('.wd-row').dataset.id==='a2' && !document.querySelector('.wd-toolbar input').readOnly");
  assert.deepEqual((await fixture.state.workDocuments.read()).documents.map(x=>x.id),['a2','b1','a1','u']);
  await browser.evaluate("document.querySelector('.wd-category > button:not(.wd-drag-handle)').click()");
  await browser.evaluate("window.originalDocumentRows=[...document.querySelectorAll('.wd-row')]");
  await drag('.wd-list','u','a2');
  await browser.waitFor("document.querySelector('.wd-row').dataset.id==='u' && !document.querySelector('.wd-toolbar input').readOnly");
  assert.equal(await browser.evaluate("originalDocumentRows.every(row=>row.isConnected)"),true);
  const expected=(await fixture.state.workDocuments.read()).documents.map(x=>x.id);
  assert.deepEqual(expected,['u','a2','b1','a1']);
  await browser.evaluate("(()=>{const s=document.querySelector('.wd-toolbar input');s.value='甲';s.dispatchEvent(new Event('input'));})()");
  assert.equal(await browser.evaluate("[...document.querySelectorAll('.wd-drag-handle')].every(n=>n.disabled)"),true);
  await browser.evaluate("(()=>{const s=document.querySelector('.wd-toolbar input');s.value='';s.dispatchEvent(new Event('input'));const original=fetch;window.fetch=(url,options)=>options?.method==='PUT'&&String(url)==='/api/work-documents'?Promise.resolve(new Response(JSON.stringify({error:'模拟保存失败'}),{status:500,headers:{'Content-Type':'application/json'}})):original(url,options);})()");
  await browser.evaluate("window.beforeFailureRows=[...document.querySelectorAll('.wd-row')]");
  await drag('.wd-list','a1','u');
  await browser.waitFor("document.querySelector('.wd-notice').textContent.includes('排序保存失败')");
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('.wd-row')].map(n=>n.dataset.id)"),expected);
  assert.equal(await browser.evaluate("beforeFailureRows.every(row=>row.isConnected)"),true);
  assert.deepEqual((await fixture.state.workDocuments.read()).documents.map(x=>x.id),expected);
});
