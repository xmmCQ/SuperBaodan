import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReading } from "../app/renderer/core/reading-settings.js";
import { clampPanelWidth, panelBounds } from "../app/renderer/assistant/workspace-panel.js";
import { fileTabKey } from "../app/renderer/assistant/file-tabs.js";
import { edgeAvailable, launchBrowser } from "./helpers/browser-harness.mjs";
import { createSmokeServer } from "./helpers/smoke-server.mjs";

const paint = (browser) => browser.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
async function browserFixture(t, size) {
  const fixture = await createSmokeServer();
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await launchBrowser(size);
  return { fixture, browser };
}

test('目录树按需加载深层目录，空目录不重复读取、失败可重试、旧响应不填入页面', { timeout: 25000 }, async t => {
  if (!edgeAvailable()) return t.skip('未安装Microsoft Edge');
  const { fixture, browser } = await browserFixture(t, { width: 1400, height: 1000 });
  await browser.navigate(`http://127.0.0.1:${fixture.port}/assistant.html`);
  await browser.waitFor("modelPickerButton.textContent.includes('GPT Test')");
  const result = await browser.evaluate(`(async () => {
    const {createWorkspaceController}=await import('/assistant/workspace-controller.js');
    const state={workspace:{id:'A',name:'A'},turnFiles:{involved:[],modified:[]}};
    const calls=[], errors=[], notices=[], pending=new Map(); let attempt=0;
    const dir=(path,children)=>({name:path.split('/').pop(),path,kind:'directory',...(children===undefined?{}:{children})});
    const file=path=>({name:path.split('/').pop(),path,kind:'file'});
    const roots=[dir('a',[dir('a/b',[dir('a/b/c',[dir('a/b/c/d')])])]),dir('empty',[]),dir('retry'),dir('slow'),dir('detached'),{...dir('BaodanPark'),processDirectory:true}];
    const elements=new Proxy({}, {get:(_,key)=>document.getElementById(key)});
    const controller=createWorkspaceController({state,elements,scopedResource:x=>x,workspacePayload:x=>x,setIconBusy(){},uiDialogs:{},createMarkdownArticle:()=>document.createElement('div'),showNotice:text=>notices.push(text),showError:e=>errors.push(e.message),resizePrompt(){},loadBootstrap:async()=>{},
      invoke:async(name,args)=>{
        calls.push(args.path||'root');
        if(!args.path)return {entries:roots,truncated:true};
        if(args.path==='slow'||args.path==='detached')return new Promise(resolve=>pending.set(args.path,resolve));
        if(args.path==='retry'&&++attempt===1)throw new Error('retryable');
        if(args.path==='a/b/c/d')return {entries:[dir('a/b/c/d/e',[dir('a/b/c/d/e/f')])]};
        if(args.path==='a/b/c/d/e/f')return {entries:[file('a/b/c/d/e/f/deep.txt')]};
        return {entries:[file(args.path+'/loaded.txt')],truncated:args.path==='BaodanPark'};
      }});
    const find=p=>[...workspaceTree.querySelectorAll('button')].find(b=>b.dataset.tooltip===p);
    const click=async p=>{const b=find(p);if(!b)return false;b.click();for(let i=0;i<100&&b.disabled;i++)await new Promise(r=>setTimeout(r,1));return true;};
    await controller.loadWorkspaceTree();
    await click('a/b/c/d');await click('a/b/c/d/e/f');
    const deepFile=!!find('a/b/c/d/e/f/deep.txt');
    await click('empty');await click('empty');
    await click('retry');await click('retry');
    const retryRecovered=!!find('retry/loaded.txt');
    await click('BaodanPark');
    const parkLoaded=!!find('BaodanPark/loaded.txt');
    const old=find('slow');old.click();await Promise.resolve();
    controller.setWorkspace({id:'B',name:'B'});workspaceTree.textContent='new workspace';
    pending.get('slow')?.({entries:[file('STALE.txt')]});await new Promise(r=>setTimeout(r,0));
    const noStale=workspaceTree.textContent==='new workspace';
    await controller.loadWorkspaceTree();
    const detached=find('detached'), oldItem=detached.parentElement;detached.click();await Promise.resolve();
    await controller.loadWorkspaceTree();
    pending.get('detached')?.({entries:[file('DETACHED.txt')]});await new Promise(r=>setTimeout(r,0));
    return {deepFile,retryRecovered,parkLoaded,noStale,detachedUntouched:!oldItem.textContent.includes('DETACHED'),emptyReads:calls.filter(p=>p==='empty').length,retries:calls.filter(p=>p==='retry').length,errors,limitNotices:notices.filter(s=>/上限|部分|截断/.test(s)).length};
  })()`);
  assert.equal(result.deepFile, true); assert.equal(result.retryRecovered, true); assert.equal(result.parkLoaded, true);
  assert.equal(result.noStale, true); assert.equal(result.detachedUntouched, true);
  assert.equal(result.emptyReads, 0); assert.equal(result.retries, 2); assert.deepEqual(result.errors, ['retryable']);
  assert.ok(result.limitNotices >= 2);
  assert.deepEqual(browser.issues, []);
});

test("阅读偏好校验、动态宽度边界及文件标签身份", () => {
  assert.deepEqual(normalizeReading(null), { size: "standard", width: "standard" });
  assert.deepEqual(normalizeReading({ size: "large", width: "wide" }), { size: "large", width: "wide" });
  assert.deepEqual(normalizeReading({ size: "999px", width: "99999px" }), { size: "standard", width: "standard" });
  assert.deepEqual(panelBounds(1100, 195), { min: 280, max: 385 });
  assert.equal(clampPanelWidth(9000, panelBounds(1100, 195)), 385);
  assert.equal(clampPanelWidth("invalid", panelBounds(1440, 195)), 330);
  assert.equal(fileTabKey("./reports/../Reports/a.md"), fileTabKey("reports\\a.md"));
  assert.notEqual(fileTabKey("reports/a.md"), fileTabKey("other/a.md"));
});

test("阅读设置立即生效、持久化且保持锚点，不放大工具栏或撑坏正文", { timeout: 35000 }, async (t) => {
  if (!edgeAvailable()) return t.skip("未安装Microsoft Edge");
  const { fixture, browser } = await browserFixture(t, { width: 1600, height: 1000 });
  const long = Array.from({ length: 8 }, (_, i) => `段落${i}：${"这是长篇报告的阅读内容。".repeat(25)}`).join("\n\n");
  const difficult = `\n\n| 表头一 | 表头二 |\n|---|---|\n| ${"长表格单元格".repeat(20)} | 内容 |\n\n\`\`\`text\n${"code_".repeat(200)}\n\`\`\`\n\nhttps://example.test/${"longlink".repeat(100)}`;
  fixture.state.messages.set("seed", Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: i % 2 ? long + difficult : `问题 ${i}` }] })));
  const base = `http://127.0.0.1:${fixture.port}`;
  await browser.navigate(`${base}/assistant.html`);
  await browser.waitFor("document.querySelectorAll('#messages > .message').length === 20");
  await paint(browser);
  const toolbarSize = await browser.evaluate("getComputedStyle(settingsButton).fontSize");
  const sidebarSize = await browser.evaluate("getComputedStyle(sessionList).fontSize");
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#messages .bubble')).fontSize"), "16px");
  await browser.evaluate("messages.style.scrollBehavior='auto'; messages.scrollTop=messages.scrollHeight/2"); await paint(browser);
  assert.equal(await browser.evaluate("Boolean(document.getElementById('statsButton') || document.getElementById('readingSettingsButton'))"), false);
  await browser.evaluate("settingsButton.click(); document.querySelector('[data-settings-tab=reading]').click()");
  await browser.evaluate("(async () => { const {captureReadingPosition}=await import('/core/reading-position.js'); window.readAnchor=captureReadingPosition(messages); const select=document.querySelector('.reading-settings-inline [name=size]');select.value='large';select.dispatchEvent(new Event('change')); return true; })()");
  await paint(browser);
  const offsetError = await browser.evaluate("Math.abs(readAnchor.anchor.getBoundingClientRect().top-messages.getBoundingClientRect().top-(readAnchor.fraction ? -readAnchor.fraction*readAnchor.anchor.getBoundingClientRect().height : readAnchor.offset))");
  assert.ok(offsetError < 3, `字号调整锚点偏移 ${offsetError}`);
  assert.equal(await browser.evaluate("getComputedStyle(readAnchor.anchor).fontSize"), "18px");
  await browser.evaluate("(() => { const select=document.querySelector('.reading-settings-inline [name=width]');select.value='wide';select.dispatchEvent(new Event('change')); })()");
  await paint(browser);
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#messages .bubble')).fontSize"), "18px");
  assert.equal(await browser.evaluate("getComputedStyle(settingsButton).fontSize"), toolbarSize);
  assert.equal(await browser.evaluate("getComputedStyle(sessionList).fontSize"), sidebarSize);
  assert.equal(await browser.evaluate("messages.scrollWidth <= messages.clientWidth+1"), true);
  await browser.navigate(`${base}/assistant.html`);
  await browser.waitFor("messages.dataset.readingSize === 'large' && document.querySelectorAll('#messages > .message').length === 20");
  assert.equal(await browser.evaluate("messages.dataset.readingWidth"), "wide");
  await browser.navigate(`${base}/`);
  await browser.waitFor("document.documentElement.classList.contains('app-ready') && document.querySelectorAll('#chatMessages > .message').length === 20");
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#chatMessages > .message')).fontSize"), "18px");
  assert.equal(await browser.evaluate("chatMessages.scrollWidth <= chatMessages.clientWidth+1"), true);
  assert.equal(await browser.evaluate("Boolean(document.getElementById('readingSettingsButton'))"), false);
  await browser.navigate(`${base}/assistant.html`);
  await browser.waitFor("modelPickerButton.textContent.includes('GPT Test')");
  await browser.evaluate("settingsButton.click(); document.querySelector('[data-settings-tab=reading]').click(); document.querySelector('.reading-reset').click()");
  await browser.navigate(`${base}/`);
  await browser.waitFor("document.documentElement.classList.contains('app-ready') && document.querySelectorAll('#chatMessages > .message').length === 20");
  await paint(browser);
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#chatMessages > .message')).fontSize"), "16px");
  assert.equal(await browser.evaluate("chatMessages.dataset.readingWidth"), "standard");
  assert.deepEqual(browser.issues, []);
});

test("标签保留iframe实例，工作区切换取消读取并忽略迟到结果", { timeout: 20000 }, async (t) => {
  if (!edgeAvailable()) return t.skip("未安装Microsoft Edge");
  const { fixture, browser } = await browserFixture(t, { width: 1400, height: 1000 });
  await browser.navigate(`http://127.0.0.1:${fixture.port}/assistant.html`);
  const result = await browser.evaluate(`(async () => {
    const {createFileTabs}=await import('/assistant/file-tabs.js');
    const wrapper=document.createElement('div');wrapper.style.cssText='position:fixed;inset:100px 200px;background:white;z-index:100';document.body.append(wrapper);
    const elements=Object.fromEntries(['fileTabs','filePreview','previewTitle','insertPreviewPath'].map(key=>[key,document.createElement('div')]));
    elements.filePreview.style.cssText='height:300px;display:flex;overflow:hidden';
    wrapper.append(...Object.values(elements));
    let completeSlow, slowSignal, activePath, notices=[];
    const tabs=createFileTabs({elements,contentUrl:url=>url,createMarkdownArticle:()=>document.createElement('div'),onNotice:text=>notices.push(text),onError:error=>{throw error;},onActivePath:path=>{activePath=path;},
      loadFile:async(path,{signal})=>path==='slow.txt'?new Promise(resolve=>{completeSlow=resolve;slowSignal=signal;}):({path,kind:path.endsWith('.pdf')?'pdf':'text',contentUrl:'about:blank',content:'text'})});
    tabs.setWorkspace('one');await tabs.open('doc.pdf');
    const frame=elements.filePreview.querySelector('iframe');await new Promise(resolve=>setTimeout(resolve,40));
    frame.contentWindow.testMarker='retained';
    await tabs.open('other.txt');await tabs.open('doc.pdf');
    const sameFrame=frame===elements.filePreview.querySelector('iframe')&&frame.contentWindow.testMarker==='retained';
    const pending=tabs.open('slow.txt');tabs.setWorkspace('two');completeSlow({path:'slow.txt',kind:'text',content:'MUST_NOT_RENDER'});await pending;
    const result={sameFrame,aborted:slowSignal.aborted,tabCount:elements.fileTabs.children.length,activePath,staleContent:wrapper.textContent.includes('MUST_NOT_RENDER'),clearedNotice:notices.some(text=>text.includes('旧文件标签已关闭'))};
    wrapper.remove();return result;
  })()`);
  assert.deepEqual(result, { sameFrame: true, aborted: true, tabCount: 0, activePath: null, staleContent: false, clearedNotice: true });
  assert.deepEqual(browser.issues, []);
});

test("文件面板拖动、恢复、记忆、放大、树折叠和多文件独立阅读位置", { timeout: 40000 }, async (t) => {
  if (!edgeAvailable()) return t.skip("未安装Microsoft Edge");
  const { fixture, browser } = await browserFixture(t, { width: 1600, height: 1000 });
  fixture.state.files.set("reports/report.md", Array.from({ length: 100 }, (_, i) => `## 报告段落 ${i}\n\n${"正文内容。".repeat(35)}`).join("\n\n"));
  fixture.state.files.set("other/report.md", Array.from({ length: 200 }, (_, i) => `另外的报告 ${i}\n\n正文`).join("\n\n"));
  fixture.state.files.set("logs/run.txt", Array.from({ length: 500 }, (_, i) => `log line ${i}`).join("\n"));
  const base = `http://127.0.0.1:${fixture.port}`;
  const openFile = async (path) => {
    await browser.evaluate(`Array.from(workspaceTree.querySelectorAll('button')).find(b=>b.dataset.tooltip===${JSON.stringify(path)}).click()`);
    await browser.waitFor(`previewTitle.textContent === ${JSON.stringify(path)} && !document.querySelector('.file-preview-pane:not(.hidden)').textContent.includes('正在读取文件')`);
    await paint(browser);
  };
  await browser.navigate(`${base}/assistant.html`);
  await browser.waitFor("modelPickerButton.textContent.includes('GPT Test')");
  await browser.evaluate("showWorkspace.click()"); await browser.waitFor("workspaceTree.innerText.includes('reports/report.md')");
  assert.equal(await browser.evaluate("Math.round(workspacePanel.getBoundingClientRect().width)"), 330);
  await openFile("reports/report.md");
  await browser.evaluate("document.querySelector('.file-preview-pane:not(.hidden)').scrollTop=700"); await paint(browser);
  const position = await browser.evaluate("document.querySelector('.file-preview-pane:not(.hidden)').scrollTop");
  await openFile("other/report.md");
  await browser.evaluate("document.querySelector('.file-preview-pane:not(.hidden)').scrollTop=300");
  await openFile("reports/report.md");
  assert.equal(await browser.evaluate("document.querySelector('.file-preview-pane:not(.hidden)').scrollTop"), position);
  assert.equal(await browser.evaluate("fileTabs.querySelectorAll('[role=tab]').length"), 2);
  assert.equal(await browser.evaluate("Array.from(fileTabs.querySelectorAll('[role=tab]')).every(b=>b.textContent.includes('—'))"), true);
  const reads = fixture.state.operations.filter((item) => item === "workspace:preview").length;
  await openFile("reports/report.md"); assert.equal(fixture.state.operations.filter((item) => item === "workspace:preview").length, reads);
  const drag = (delta, ending = "pointerup") => browser.evaluate(`(async () => {
    const x=workspaceResize.getBoundingClientRect().left;
    workspaceResize.dispatchEvent(new PointerEvent('pointerdown',{pointerId:7,pointerType:'mouse',button:0,buttons:1,clientX:x,bubbles:true}));
    for (let step=1;step<=10;step++) {
      window.dispatchEvent(new PointerEvent('pointermove',{pointerId:7,pointerType:'mouse',buttons:1,clientX:x-${delta}*step/10}));
      await new Promise(requestAnimationFrame);
    }
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    window.dragLiveWidth=Math.round(workspacePanel.getBoundingClientRect().width);
    window.dispatchEvent(new PointerEvent('${ending}',{pointerId:7,pointerType:'mouse',buttons:0,clientX:x-${delta}}));
  })()`);
  await drag(150); await paint(browser);
  assert.equal(await browser.evaluate("window.dragLiveWidth"), 480);
  assert.equal(await browser.evaluate("document.querySelector('.assistant-shell').classList.contains('workspace-resizing') || Boolean(messages.dataset.readingAdjustment)"), false);
  assert.equal(await browser.evaluate("Math.round(workspacePanel.getBoundingClientRect().width)"), 480);
  assert.equal(await browser.evaluate("document.body.style.cursor + document.body.style.userSelect"), "");
  await drag(5000, "pointercancel"); await paint(browser);
  assert.ok(await browser.evaluate("document.querySelector('.chat-main').getBoundingClientRect().width >= 519"));
  assert.equal(await browser.evaluate("document.querySelector('.toolbar').scrollWidth <= document.querySelector('.toolbar').clientWidth+1"), true);
  assert.equal(await browser.evaluate("document.body.style.cursor + document.body.style.userSelect"), "");
  await browser.evaluate("workspaceResize.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"); await paint(browser);
  assert.equal(await browser.evaluate("Math.round(workspacePanel.getBoundingClientRect().width)"), 330);
  await drag(100); await paint(browser);
  await browser.evaluate("collapseWorkspace.click(); showWorkspace.click()"); await paint(browser);
  assert.equal(await browser.evaluate("Math.round(workspacePanel.getBoundingClientRect().width)"), 430);
  await browser.evaluate("toggleWorkspaceTree.click()"); await paint(browser);
  assert.equal(await browser.evaluate("getComputedStyle(workspaceTree).display"), "none");
  await browser.evaluate("(async () => { const {captureReadingPosition}=await import('/core/reading-position.js'); window.previewPane=document.querySelector('.file-preview-pane:not(.hidden)');window.previewAnchor=captureReadingPosition(previewPane);return true; })()");
  await browser.evaluate("enlargePreview.click()"); await paint(browser);
  assert.equal(await browser.evaluate("enlargePreview.getAttribute('aria-pressed')"), "true");
  assert.equal(await browser.evaluate("window.previewPane === document.querySelector('.file-preview-pane:not(.hidden)')"), true);
  assert.equal(await browser.evaluate("previewTitle.textContent"), "reports/report.md");
  await browser.evaluate("enlargePreview.click()"); await paint(browser);
  assert.equal(await browser.evaluate("Math.round(workspacePanel.getBoundingClientRect().width)"), 430);
  assert.equal(await browser.evaluate("getComputedStyle(workspaceTree).display"), "none");
  const anchorError = await browser.evaluate("Math.abs(previewAnchor.anchor.getBoundingClientRect().top-previewPane.getBoundingClientRect().top-(previewAnchor.fraction ? -previewAnchor.fraction*previewAnchor.anchor.getBoundingClientRect().height : previewAnchor.offset))");
  assert.ok(anchorError < 3, `放大往返锚点偏移 ${anchorError}`);
  await browser.evaluate("fileTabs.querySelector('.file-tab.active .file-tab-close').click()");
  assert.equal(await browser.evaluate("previewTitle.textContent"), "other/report.md");
  for (const res of fixture.state.eventClients) res.write(`data: ${JSON.stringify({ type: "workspace_changed", workspace: { id: "w2", name: "新工作区", root: "C:\\isolated" } })}\n\n`);
  await browser.waitFor("fileTabs.children.length === 0 && previewTitle.textContent === '预览'");
  await browser.navigate(`${base}/assistant.html`); await browser.waitFor("modelPickerButton.textContent.includes('GPT Test')");
  await browser.evaluate("showWorkspace.click()"); await paint(browser);
  assert.equal(await browser.evaluate("Math.round(workspacePanel.getBoundingClientRect().width)"), 430);
  assert.deepEqual(browser.issues, []);
});
