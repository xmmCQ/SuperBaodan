import test from 'node:test';
import assert from 'node:assert/strict';
import { browserScenario, paint } from './helpers/browser-scenario.mjs';

test('会话更多菜单独立操作、键盘关闭、默认宽度与旧宽度偏好', { timeout: 30000 }, async t => {
  const scenario = await browserScenario(t); if (!scenario) return;
  const { fixture, browser } = scenario;
  fixture.state.sessions.push({ id:'other',path:'/temp/other.jsonl',title:'另一个很长的会话名称用于验证单行省略及完整提示',name:'另一会话',modified:'2026-09-04T08:30:00Z',messageCount:120 });
  const url=`http://127.0.0.1:${fixture.port}/assistant.html`;
  await browser.navigate(url); await browser.waitFor("document.querySelectorAll('.session-row').length===2");
  assert.equal(await browser.evaluate('sessionSidebar.getBoundingClientRect().width'),240);
  const before=fixture.state.activeSessionId;
  await browser.evaluate("window.more=document.querySelector('.session-row:not(.active) .session-more'); more.click()");
  await browser.waitFor("more.getAttribute('aria-expanded')==='true'");
  assert.equal(fixture.state.activeSessionId,before);
  assert.equal(await browser.evaluate("document.querySelector('.session-menu:popover-open').getAttribute('role')"),'menu');
  assert.ok(await browser.evaluate("[more,...document.querySelectorAll('.session-menu:popover-open button')].every(b=>b.querySelector('svg')&&b.getBoundingClientRect().height>=32)"));
  assert.equal(await browser.evaluate("more.getBoundingClientRect().width===32 && document.activeElement.getAttribute('aria-label')==='重命名'"),true);
  await browser.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));");
  assert.equal(await browser.evaluate("document.activeElement.classList.contains('danger')"),true);
  await browser.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));");
  await browser.waitFor("!document.querySelector('.session-menu:popover-open') && document.activeElement===more");
  await browser.evaluate("more.click();document.querySelector('.session-menu:popover-open .danger').click()");
  await browser.waitFor('uiDialog.open');
  assert.equal(fixture.state.activeSessionId,before); assert.match(await browser.evaluate('uiDialogMessage.textContent'),/另一个很长/);
  await browser.evaluate('uiDialogCancel.click()'); assert.equal(fixture.state.sessions.length,2);
  await browser.evaluate("localStorage.setItem('super-baodan.sidebar-width.v1','195')");
  await browser.navigate(url); await browser.waitFor("document.querySelectorAll('.session-row').length===2");
  assert.equal(await browser.evaluate('sessionSidebar.getBoundingClientRect().width'),195);
  assert.equal(await browser.evaluate("[...document.querySelectorAll('.session-meta span')].every(e=>getComputedStyle(e).whiteSpace==='nowrap' && e.getBoundingClientRect().width<=e.closest('.session-item').getBoundingClientRect().width)"),true);
  await browser.evaluate("sidebarResize.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
  await paint(browser);
  assert.equal(await browser.evaluate('sessionSidebar.getBoundingClientRect().width'),240);
});

test('助手在桌面最小至超宽尺寸下，文件面板开关不撑宽且输入操作可见', { timeout: 35000 }, async t => {
  const scenario = await browserScenario(t); if (!scenario) return;
  const { browser, navigate } = scenario; await navigate();
  await browser.waitFor("document.querySelectorAll('#messages > .message').length>=2");
  for (const [width,height] of [[950,606],[1280,720],[1440,900],[1920,1080],[2560,1440]]) {
    await browser.setViewport(width,height); await paint(browser);
    for (const open of [false,true]) {
      await browser.evaluate(`(()=>{const shell=document.querySelector('.assistant-shell');if(shell.classList.contains('workspace-closed')===${open})showWorkspace.click()})()`);
      await paint(browser);
      const measured = await browser.evaluate("(()=>{const box=document.querySelector('.chat-main').getBoundingClientRect(),input=promptInput.getBoundingClientRect(),send=sendButton.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,inputWidth:input.width,inputVisible:input.bottom<=innerHeight,sendVisible:send.right<=box.right&&send.bottom<=innerHeight,sendSize:[send.width,send.height],panesFit:[...document.querySelectorAll('.sidebar,.chat-main')].every(e=>e.scrollWidth<=e.clientWidth+1)}})()");
      assert.equal(measured.overflow,false,JSON.stringify({width,open,measured})); assert.equal(measured.panesFit,true);
      assert.ok(measured.inputWidth>=60); assert.equal(measured.inputVisible,true); assert.equal(measured.sendVisible,true);
      assert.deepEqual(measured.sendSize,[40,40]);
    }
  }
});
