import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './helpers/browser-harness.mjs';

async function setup(t) {
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await launchBrowser({ width: 1600, height: 1000 });
  await browser.addInitScript("window.docReads=0;const nativeFetch=fetch;window.fetch=(...args)=>{if(String(args[0])==='/api/work-documents'&&(!args[1]?.method||args[1].method==='GET'))docReads++;return nativeFetch(...args)};");
  await browser.navigate(`http://127.0.0.1:${fixture.port}/`);
  await browser.waitFor("!document.documentElement.classList.contains('app-loading')");
  assert.equal(await browser.evaluate('docReads'), 0);
  await browser.evaluate('workDocumentsButton.click()');
  await browser.waitFor("document.querySelector('.wd-toolbar .wd-primary')?.disabled===false");
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.wd-dialog')).backgroundColor"), 'rgba(255, 255, 255, 0.96)');
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.wd-dialog .modal-heading')).backgroundColor"), 'rgba(0, 0, 0, 0)');
  assert.equal(await browser.evaluate("document.querySelector('.wd-dialog').dataset.glassShade"), 'active');
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.wd-dialog h3')).fontSize"), '20px');
  assert.equal(await browser.evaluate("[...document.querySelectorAll('.wd-toolbar button,.wd-download-template,.wd-dialog .modal-heading button')].every(n=>getComputedStyle(n).fontSize==='14px' && getComputedStyle(n).borderRadius==='9999px' && n.getBoundingClientRect().height>=36)"), true);
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.wd-toolbar .wd-primary')).backgroundColor"), 'rgb(10, 10, 10)');
  const click = (selector, label) => browser.evaluate(`(()=>{
    const button=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>(b.getAttribute('aria-label')||b.textContent.trim())===${JSON.stringify(label)});
    if(!button)throw new Error('找不到操作：'+${JSON.stringify(label)});
    button.click();
  })()`);
  const reload = async () => {
    await browser.evaluate("document.querySelector('.wd-dialog').close();workDocumentsButton.click()");
    await browser.waitFor("document.querySelector('.wd-toolbar .wd-primary')?.disabled===false");
  };
  const fill = (label, value) => browser.evaluate(`(()=>{const el=document.querySelector('.wd-editor[open] [aria-label='+${JSON.stringify(JSON.stringify(label))}+']');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const save = async () => { await browser.evaluate("document.querySelector('.wd-editor[open] form').requestSubmit()"); await browser.waitFor("!document.querySelector('.wd-editor[open]')"); };
  return { fixture, browser, click, fill, save, reload };
}
test('文档弹窗懒加载、分类/入口管理、搜索、打开防重及只删除入口', { timeout: 25000 }, async t => {
  if (!edgeAvailable()) return t.skip('需要 Edge');
  const { fixture, browser, click, fill, save } = await setup(t);
  const download = await browser.evaluate("(()=>{const a=document.querySelector('.wd-download-template');return {href:a.getAttribute('href'),name:a.download}})()");
  assert.equal(download.name, '工作文档导入模板.md');
  const templateResponse = await fetch(`http://127.0.0.1:${fixture.port}${download.href}`);
  assert.equal(templateResponse.status, 200); assert.match(await templateResponse.text(), /# 工作排班/);
  const file = path.join(fixture.root, '原始资料.txt'); await fs.writeFile(file, '必须保留');
  await click('.wd-categories button', '添加分类'); await fill('分类名称', '业务资料'); await save();
  assert.equal(await browser.evaluate("document.querySelector('.wd-category > button.active').textContent"), '业务资料 · 0');
  await click('.wd-toolbar button', '添加文档'); await fill('文档名称', '本地资料'); await fill('文件路径或网址', file);
  const categoryId = (await fixture.state.workDocuments.read()).categories.find(c => c.name === '业务资料').id;
  assert.equal(await browser.evaluate("document.querySelector('.wd-editor select[aria-label=分类]').value"), categoryId);
  // Force mouse/keyboard focus states: headless Edge may keep the page inactive.
  for (const pseudo of [['focus'], ['focus', 'focus-visible']]) {
    await browser.forcePseudoState('.wd-editor[open] select', pseudo);
    const focusRing = await browser.evaluate(`(async()=>{
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const style=getComputedStyle(document.querySelector('.wd-editor[open] select'));
      return {width:style.outlineWidth,offset:style.outlineOffset};
    })()`);
    assert.deepEqual(focusRing, {width:'2px',offset:'-2px'});
  }
  await browser.forcePseudoState('.wd-editor[open] select', []);
  await save();
  await browser.evaluate("const b=document.querySelector('.wd-doc-name');b.click();b.click()");
  await browser.waitFor("document.querySelector('.wd-notice').textContent.includes('已交给系统')");
  assert.equal(fixture.state.operations.filter(s => s.startsWith('document:open:')).length, 1);
  await browser.evaluate("document.querySelector('.wd-toolbar input').value='业务资料';document.querySelector('.wd-toolbar input').dispatchEvent(new Event('input'))");
  assert.equal(await browser.evaluate("document.querySelectorAll('.wd-row').length"), 1);
  await browser.evaluate("document.querySelector('.wd-toolbar input').value='不存在';document.querySelector('.wd-toolbar input').dispatchEvent(new Event('input'))");
  assert.equal(await browser.evaluate("document.querySelectorAll('.wd-row').length"), 0);
  await browser.evaluate("document.querySelector('.wd-toolbar input').value='';document.querySelector('.wd-toolbar input').dispatchEvent(new Event('input'))");
  await click('.wd-category-menu button', '删除分类'); await browser.waitFor("document.querySelector('#uiDialog')?.open"); await browser.evaluate('uiDialogConfirm.click()');
  await browser.waitFor("document.querySelector('.wd-category button').textContent.includes('全部')&&!document.querySelector('.wd-category-menu')");
  assert.equal((await fixture.state.workDocuments.read()).documents[0].categoryId, 'uncategorized');
  await browser.evaluate("document.querySelector('.wd-row-actions [data-remove-document]').click()");
  assert.equal(await browser.evaluate('uiDialog.open'), false);
  await browser.waitFor("document.querySelectorAll('.wd-row').length===0");
  assert.equal(await fs.readFile(file, 'utf8'), '必须保留'); assert.deepEqual(browser.issues, []);
});
test('Markdown预览与修复、重复导入、非链接正文不出浏览器、冲突保留草稿', { timeout: 25000 }, async t => {
  if (!edgeAvailable()) return t.skip('需要 Edge');
  const { fixture, browser, click, fill, save } = await setup(t);
  const md = '# 常用\n[共享文档](https://example.com/doc?a=1#part)\nPRIVATE_MARKER_NEVER_SEND\n[待修复](../missing.txt)';
  const upload = async () => {
    await browser.evaluate(`(()=>{const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(md)}],'index.md',{type:'text/markdown'}));const input=document.querySelector('.wd-dialog input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change'));})()`);
    await browser.waitFor("document.querySelectorAll('.wd-import-row').length===2");
  };
  await upload();
  assert.ok(await browser.evaluate("document.querySelector('.wd-import-summary').textContent.includes('无效 1')"));
  await save(); assert.equal((await fixture.state.workDocuments.read()).documents.length, 1);
  assert.equal(JSON.stringify(fixture.state.documentRequests).includes('PRIVATE_MARKER'), false);
  assert.equal(await browser.evaluate("document.querySelector('a.wd-doc-name').target"), '_blank');
  assert.equal(await browser.evaluate("document.querySelector('a.wd-doc-name').rel"), 'noopener noreferrer');
  await upload(); await save(); assert.equal((await fixture.state.workDocuments.read()).documents.length, 1);
  await click('.wd-row-actions button', '编辑文档入口'); await fill('文档名称', '保留的新名称');
  const latest = await fixture.state.workDocuments.read(); await fixture.state.workDocuments.save({ ...latest, categories: [...latest.categories, { id: 'external', name: '其他页面新增' }] });
  await browser.evaluate("document.querySelector('.wd-editor[open] form').requestSubmit()");
  await browser.waitFor("document.querySelector('.wd-editor .wd-notice').textContent.includes('草稿')");
  assert.equal(await browser.evaluate("document.querySelector('.wd-editor [aria-label=文档名称]').value"), '保留的新名称');
  await click('.wd-footer button', '重新读取目录版本');
  await browser.waitFor("document.querySelector('.wd-editor .wd-notice').textContent.includes('已读取最新')");
  await save(); const result = await fixture.state.workDocuments.read();
  assert.equal(result.documents[0].name, '保留的新名称'); assert.ok(result.categories.some(c => c.id === 'external'));
  // A discarded new draft never changes persisted data.
  await click('.wd-toolbar button', '添加文档'); await fill('文档名称', '不保存'); await click('.wd-footer button', '取消');
  await browser.waitFor("document.querySelector('#uiDialog')?.open"); await browser.evaluate('uiDialogConfirm.click()');
  await browser.waitFor("!document.querySelector('.wd-editor[open]')"); assert.equal((await fixture.state.workDocuments.read()).documents.length, 1);
  assert.deepEqual(browser.issues, []);
});

test('大量导入条目仅列表滚动，确认操作固定在顶部', { timeout: 25000 }, async t => {
  if (!edgeAvailable()) return t.skip('需要 Edge');
  const { fixture, browser } = await setup(t);
  const md = Array.from({ length: 120 }, (_, i) => `[文档${i}](https://example.com/docs/${i})`).join('\n');
  await browser.evaluate(`(()=>{const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(md)}],'many.md',{type:'text/markdown'}));const input=document.querySelector('.wd-dialog input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change'));})()`);
  await browser.waitFor("document.querySelectorAll('.wd-import-row').length===120");
  await browser.evaluate("document.querySelector('.wd-import-row input[type=checkbox]').click()");
  assert.equal(await browser.evaluate("document.querySelector('.wd-import-row').classList.contains('is-excluded') && !document.querySelector('.wd-import-excluded').classList.contains('hidden')"), true);
  await browser.waitFor("getComputedStyle(document.querySelector('.wd-import-row')).backgroundColor === 'rgb(228, 232, 238)'");
  await browser.evaluate("document.querySelector('.wd-import-row input[type=checkbox]').click()");
  assert.equal(await browser.evaluate("document.querySelector('.wd-import-row').classList.contains('is-excluded')"), false);
  await browser.evaluate("document.querySelector('.wd-import-row input[type=checkbox]').click()");
  const position = () => browser.evaluate(`(()=>{const d=document.querySelector('.wd-import'),body=d.querySelector('fieldset'),bar=d.querySelector('.wd-footer'),r=bar.getBoundingClientRect(),b=body.getBoundingClientRect();return {top:r.top,bottom:r.bottom,bodyTop:b.top,scrollable:body.scrollHeight>body.clientHeight,hiddenReload:getComputedStyle(bar.querySelector('[hidden]')).display,visibleButtons:[...bar.querySelectorAll('button:not([hidden])')].every(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.height>=32})};})()`);
  const before = await position();
  assert.ok(before.scrollable && before.visibleButtons && before.bottom <= before.bodyTop);
  assert.equal(before.hiddenReload, 'none');
  await browser.evaluate("const body=document.querySelector('.wd-import fieldset');body.scrollTop=body.scrollHeight");
  const after = await position();
  assert.equal(after.top, before.top);
  assert.ok(after.visibleButtons);
  await browser.evaluate("document.querySelector('.wd-import .wd-footer .wd-primary').click()");
  await browser.waitFor("!document.querySelector('.wd-import[open]')");
  assert.equal((await fixture.state.workDocuments.read()).documents.length, 119);
});

test('文档空分类显示并保留选中、可排序，删除分类后回到全部', { timeout: 25000 }, async t => {
  if (!edgeAvailable()) return t.skip('需要 Edge');
  const { fixture, browser, click, reload } = await setup(t);
  const current = await fixture.state.workDocuments.read();
  await fixture.state.workDocuments.save({ ...current,
    categories: [...current.categories, { id:'business', name:'业务资料' }, { id:'empty', name:'空分类' }],
    documents: [
      { id:'one', name:'资料一', kind:'url', target:'https://example.com/one', categoryId:'uncategorized' },
      { id:'two', name:'资料二', kind:'url', target:'https://example.com/two', categoryId:'business' },
    ],
  });
  await reload();
  await browser.waitFor("document.querySelectorAll('.wd-row').length===2");
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('.wd-category > button:not(.wd-drag-handle):not(.wd-icon-button)')].map(n=>n.textContent)"), ['全部 · 2','业务资料 · 1','空分类 · 0','未分类 · 1']);
  await click('.wd-category > button:not(.wd-drag-handle):not(.wd-icon-button)', '业务资料 · 1');
  const next = await fixture.state.workDocuments.read();
  await fixture.state.workDocuments.save({ ...next, documents: next.documents.filter(d=>d.id!=='two') });
  await reload();
  await browser.waitFor("document.querySelector('.wd-category > button.active')?.textContent==='业务资料 · 0'");
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('.wd-category > button:not(.wd-drag-handle):not(.wd-icon-button)')].map(n=>n.textContent)"), ['全部 · 1','业务资料 · 0','空分类 · 0','未分类 · 1']);
  assert.equal(await browser.evaluate("document.querySelectorAll('.wd-row').length"), 0);
  await browser.evaluate(`(()=>{const from=document.querySelector('[data-sort-id=empty] .wd-drag-handle'),to=document.querySelector('[data-sort-id=business]'),r=to.getBoundingClientRect(),dt=new DataTransfer();from.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));to.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:r.top+2}));})()`);
  await browser.waitFor("!document.querySelector('.wd-toolbar .wd-primary').disabled");
  assert.deepEqual((await fixture.state.workDocuments.read()).categories.filter(c=>c.id!=='uncategorized').map(c=>c.id), ['empty','business']);
  await reload();
  assert.equal(await browser.evaluate("document.querySelector('.wd-category[data-sort-id]').dataset.sortId"), 'empty');
  assert.ok((await fixture.state.workDocuments.read()).categories.some(c=>c.id==='empty'));
  await click('.wd-toolbar button', '添加文档');
  assert.equal(await browser.evaluate("[...document.querySelector('.wd-editor select[aria-label=分类]').options].some(n=>n.textContent==='空分类')"), true);
  assert.equal(await browser.evaluate("document.querySelector('.wd-editor select[aria-label=分类]').value"), 'business');
  await click('.wd-footer button', '取消');
  await browser.waitFor("!document.querySelector('.wd-editor[open]')");
  await click('[data-sort-id=business] .wd-category-menu button', '删除分类');
  await browser.waitFor('uiDialog.open');await browser.evaluate('uiDialogConfirm.click()');
  await browser.waitFor("document.querySelector('.wd-category > button.active')?.textContent==='全部 · 1'");
  assert.deepEqual(browser.issues, []);
});

test('源文件删除需确认勾选，关闭重置，未勾选无确认仅删入口', { timeout: 25000 }, async t => {
  if (!edgeAvailable()) return t.skip('需要 Edge');
  const { fixture, browser, click, reload } = await setup(t);
  const file=path.join(fixture.root,'待回收.txt');await fs.writeFile(file,'测试数据');
  const current=await fixture.state.workDocuments.read();
  await fixture.state.workDocuments.save({...current,documents:[{id:'remove-me',name:'测试文件',categoryId:'uncategorized',kind:'file',target:file}]});
  await reload();await browser.waitFor("document.querySelectorAll('.wd-row').length===1");
  const toggle='.wd-delete-option input';
  assert.equal(await browser.evaluate(`document.querySelector('${toggle}').checked`),false);
  await browser.evaluate(`document.querySelector('${toggle}').click()`);await browser.waitFor('uiDialog.open');
  assert.equal(await browser.evaluate('uiDialogMessage.textContent'),'勾选后删除快捷目录同时会删除源文件，是否确认勾选？');
  await browser.evaluate('uiDialogCancel.click()');
  assert.equal(await browser.evaluate(`document.querySelector('${toggle}').checked`),false);
  await browser.evaluate(`document.querySelector('${toggle}').click()`);await browser.waitFor('uiDialog.open');await browser.evaluate('uiDialogConfirm.click()');
  await browser.waitFor(`document.querySelector('${toggle}').checked`);
  await browser.evaluate("document.querySelector('.wd-dialog').close();workDocumentsButton.click()");
  await browser.waitFor(`!document.querySelector('${toggle}').disabled`);
  assert.equal(await browser.evaluate(`document.querySelector('${toggle}').checked`),false);
  await browser.evaluate(`document.querySelector('${toggle}').click()`);await browser.waitFor('uiDialog.open');await browser.evaluate('uiDialogConfirm.click()');
  await browser.waitFor(`document.querySelector('${toggle}').checked`);
  await browser.evaluate("document.querySelector('.wd-row-actions [data-remove-document]').click()");
  await browser.waitFor("document.querySelectorAll('.wd-row').length===0");
  assert.equal(await browser.evaluate('uiDialog.open'),false);
  assert.ok(fixture.state.operations.includes(`document:recycle:${file}`));
  assert.equal(await fs.readFile(path.join(fixture.root,'recycled-待回收.txt'),'utf8'),'测试数据');
});
