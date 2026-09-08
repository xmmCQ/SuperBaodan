import test from 'node:test';
import assert from 'node:assert/strict';
import { sidebarBounds, clampSidebarWidth } from '../public/assistant/sidebar-resize.js';
import { edgeAvailable, launchBrowser } from './helpers/browser-harness.mjs';
import { createSmokeServer } from './helpers/smoke-server.mjs';

const paint = (browser) => browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
test('侧栏宽度边界给聊天保留520px，同时考虑文件面板宽度', () => {
  assert.deepEqual(sidebarBounds(1400, 330), { min: 180, max: 420 });
  assert.deepEqual(sidebarBounds(1100, 385), { min: 180, max: 195 });
  assert.equal(clampSidebarWidth(5000, sidebarBounds(1100, 385)), 195);
  assert.equal(clampSidebarWidth(-1, sidebarBounds(1400, 0)), 180);
});

test('左侧栏实时伸缩、保留阅读位置、记忆宽度，与右侧边界兼容', { timeout: 25000 }, async (t) => {
  if (!edgeAvailable()) return t.skip('未安装Microsoft Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  fixture.state.messages.set('seed', Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i % 2 ? [{ type: 'text', text: `第${i}条\n\n${'用于验证阅读位置的正文。'.repeat(40)}` }] : `问题${i}` })));
  browser = await launchBrowser({ width: 1400, height: 1000 });
  const url = `http://127.0.0.1:${fixture.port}/assistant.html`;
  await browser.navigate(url);
  await browser.waitFor("document.querySelectorAll('#messages > .message').length===50"); await paint(browser);
  assert.equal(await browser.evaluate('Math.round(sessionSidebar.getBoundingClientRect().width)'), 195);
  await browser.evaluate("messages.style.scrollBehavior='auto';messages.scrollTop=messages.scrollHeight/2"); await paint(browser);
  await browser.evaluate("(async()=>{const {captureReadingPosition}=await import('/core/reading-position.js');window.anchor=captureReadingPosition(messages);})()");
  const drag = (delta, end = 'pointerup') => browser.evaluate(`(async()=>{
    const x=sidebarResize.getBoundingClientRect().left;
    sidebarResize.dispatchEvent(new PointerEvent('pointerdown',{pointerId:8,pointerType:'mouse',button:0,buttons:1,clientX:x,bubbles:true}));
    for(let i=1;i<=8;i++) {window.dispatchEvent(new PointerEvent('pointermove',{pointerId:8,pointerType:'mouse',buttons:1,clientX:x+${delta}*i/8}));await new Promise(requestAnimationFrame);}
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    window.liveSidebarWidth=Math.round(sessionSidebar.getBoundingClientRect().width);
    window.dispatchEvent(new PointerEvent('${end}',{pointerId:8,pointerType:'mouse',buttons:0,clientX:x+${delta}}));
  })()`);
  await drag(125); await paint(browser);
  assert.equal(await browser.evaluate('window.liveSidebarWidth'), 320);
  const error = await browser.evaluate('Math.abs(anchor.anchor.getBoundingClientRect().top-messages.getBoundingClientRect().top-(anchor.fraction ? -anchor.fraction*anchor.anchor.getBoundingClientRect().height : anchor.offset))');
  assert.ok(error < 3, `阅读位置偏移 ${error}`);
  assert.equal(await browser.evaluate("localStorage.getItem('super-baodan.sidebar-width.v1')"), '320');
  await browser.navigate(url); await browser.waitFor("document.querySelectorAll('#messages > .message').length===50"); await paint(browser);
  assert.equal(await browser.evaluate('Math.round(sessionSidebar.getBoundingClientRect().width)'), 320);
  await browser.evaluate('showWorkspace.click()'); await paint(browser);
  await drag(5000, 'pointercancel'); await paint(browser);
  assert.equal(await browser.evaluate('Math.round(sessionSidebar.getBoundingClientRect().width)'), 420);
  await browser.evaluate("(()=>{const x=workspaceResize.getBoundingClientRect().left;workspaceResize.dispatchEvent(new PointerEvent('pointerdown',{pointerId:9,pointerType:'mouse',buttons:1,button:0,clientX:x}));window.dispatchEvent(new PointerEvent('pointermove',{pointerId:9,pointerType:'mouse',buttons:1,clientX:x-5000}));window.dispatchEvent(new PointerEvent('pointerup',{pointerId:9,pointerType:'mouse',buttons:0}));})()"); await paint(browser);
  assert.ok(await browser.evaluate("document.querySelector('.chat-main').getBoundingClientRect().width>=519"));
  await drag(5000); await paint(browser);
  assert.ok(await browser.evaluate("document.querySelector('.chat-main').getBoundingClientRect().width>=519"));
  await browser.evaluate("sidebarResize.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"); await paint(browser);
  assert.equal(await browser.evaluate('Math.round(sessionSidebar.getBoundingClientRect().width)'), 195);
  await browser.evaluate("sidebarResize.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))"); await paint(browser);
  assert.equal(await browser.evaluate('Math.round(sessionSidebar.getBoundingClientRect().width)'), 215);
  await drag(-5000, 'blur'); await paint(browser);
  assert.equal(await browser.evaluate('Math.round(sessionSidebar.getBoundingClientRect().width)'), 180);
  assert.equal(await browser.evaluate("document.body.style.cursor+document.body.style.userSelect"), '');
  assert.equal(await browser.evaluate("document.querySelector('.assistant-shell').classList.contains('sidebar-resizing') || Boolean(messages.dataset.readingAdjustment)"), false);
  assert.deepEqual(browser.issues, []);
});
