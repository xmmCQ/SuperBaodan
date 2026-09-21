import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './helpers/browser-harness.mjs';
const paint = browser => browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');

test('会话更多菜单独立操作、键盘关闭、默认宽度与旧宽度偏好', { timeout: 30000 }, async t => {
  if (!edgeAvailable()) return t.skip('需要Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  fixture.state.sessions.push({ id:'other',path:'/temp/other.jsonl',title:'另一个很长的会话名称用于验证单行省略及完整提示',name:'另一会话',modified:'2026-09-04T08:30:00Z',messageCount:120 });
  browser = await launchBrowser(); await browser.setViewport(1440,900);
  const url=`http://127.0.0.1:${fixture.port}/assistant.html`;
  await browser.navigate(url); await browser.waitFor("document.querySelectorAll('.session-row').length===2");
  assert.equal(await browser.evaluate('sessionSidebar.getBoundingClientRect().width'),240);
  const before=fixture.state.activeSessionId;
  await browser.evaluate("window.more=document.querySelector('.session-row:not(.active) .session-more'); more.click()");
  await browser.waitFor("more.getAttribute('aria-expanded')==='true'");
  assert.equal(fixture.state.activeSessionId,before);
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
  if (!edgeAvailable()) return t.skip('需要Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await launchBrowser(); await browser.navigate(`http://127.0.0.1:${fixture.port}/assistant.html`);
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

test('两端字号三档精确一致，设置标题层级和40/36px控件稳定', { timeout: 35000 }, async t => {
  if (!edgeAvailable()) return t.skip('需要Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  const base=`http://127.0.0.1:${fixture.port}`;
  for(const [size,font] of [['small','14px'],['standard','16px'],['large','18px']]) {
    browser = await launchBrowser(); await browser.setViewport(1280,720);
    await browser.navigate(base+'/assistant.html'); await browser.waitFor("document.querySelector('#messages .bubble')");
    await browser.evaluate(`settingsButton.click(); document.querySelector('[data-settings-tab=reading]').click(); const e=document.querySelector('.reading-settings-inline [name=size]'); e.value='${size}';e.dispatchEvent(new Event('change'));`);
    await paint(browser);
    assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#messages .bubble')).fontSize"),font);
    await browser.navigate(base+'/'); await browser.waitFor("document.querySelector('#chatMessages > .message')");
    assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#chatMessages > .message')).fontSize"),font);
    await browser.close(); browser = null;
  }
  browser = await launchBrowser(); await browser.setViewport(1280,720);
  await browser.navigate(base+'/assistant.html'); await browser.waitFor("document.querySelector('#messages .bubble')");
  await browser.evaluate('settingsButton.click()'); await browser.waitFor('settingsDialog.open');
  let bounds;
  for(const tab of ['accounts','preferences','projectPrompt','skills','reading','custom']) {
    await browser.evaluate(`document.querySelector('[data-settings-tab=${tab}]').click()`);
    await browser.waitFor(`document.getElementById('${tab}Tab').classList.contains('active')`);
    if (tab === 'projectPrompt') await browser.waitFor("!document.querySelector('.project-prompt-reload').disabled");
    const actual=await browser.evaluate("(()=>{const r=settingsDialog.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()");
    if(bounds)assert.deepEqual(actual,bounds);else bounds=actual;
  }
  await browser.evaluate("document.querySelector('[data-settings-tab=preferences]').click()");
  await browser.waitFor("preferencesTab.classList.contains('active') && defaultModelSelect.options.length>0");
  await paint(browser);
  assert.deepEqual(await browser.evaluate("[getComputedStyle(settingsDialog.querySelector('.dialog-head b')).fontSize, getComputedStyle(preferencesTab.querySelector('h3')).fontSize, defaultModelSelect.getBoundingClientRect().height, defaultThinking.getBoundingClientRect().height, closeSettings.getBoundingClientRect().width]"),['20px','16px',40,40,36]);
  await browser.evaluate("document.querySelector('[data-settings-tab=accounts]').click()");
  assert.equal(await browser.evaluate('providerSearch.getBoundingClientRect().height'),36);
  assert.ok(await browser.evaluate('parseFloat(getComputedStyle(providerSearch).paddingLeft)>=34'));
});
