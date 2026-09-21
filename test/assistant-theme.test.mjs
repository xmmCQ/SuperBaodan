import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './helpers/browser-harness.mjs';

const luminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => { const x = luminance(a.match(/[\d.]+/g).slice(0,3).map(Number)), y = luminance(b.match(/[\d.]+/g).slice(0,3).map(Number)); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };

test('助手蓝色主题隔离、共享弹窗和代表性对比度', { timeout: 40000 }, async t => {
  assert.ok(edgeAvailable(), '需要现有 Edge，不安装依赖');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await launchBrowser(); await browser.setViewport(1440,900);
  const base = `http://127.0.0.1:${fixture.port}`;
  const output = new URL('../docs/screenshots/assistant-theme/', import.meta.url);
  await mkdir(output, { recursive: true });
  const style = (selector, prop = 'backgroundColor') => browser.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(prop)}]`);
  const shot = async name => { await browser.evaluate('document.fonts.ready'); await writeFile(new URL(name + '.png', output), await browser.screenshot()); };
  const dialog = async expected => {
    // Present the existing shared dialog directly: no delete/login or real data operations.
    await browser.evaluate("uiDialogTitle.textContent='主题确认';uiDialogMessage.textContent='仅验证界面配色，不执行任何操作。';uiDialogConfirm.classList.remove('danger');uiDialog.showModal()");
    assert.equal(await style('#uiDialogConfirm'), expected);
    await browser.evaluate('uiDialog.close()');
  };
  await browser.navigate(base+'/');
  await browser.waitFor("document.querySelector('#chatMessages > .message')");
  assert.equal(await style('.icon-action.icon-primary'), 'rgb(23, 25, 28)');
  await dialog('rgb(10, 10, 10)');
  await shot('home');

  await browser.navigate(base+'/assistant.html');
  await browser.waitFor("document.querySelector('.message.assistant .bubble') && document.querySelector('.session-row.active')");
  const blue='rgb(37, 99, 235)', white='rgb(255, 255, 255)', selected='rgb(234, 242, 255)';
  assert.equal(await style('#sendButton'),blue);
  assert.equal(await style('.message.user .bubble'),blue);
  assert.equal(await style('.message.user .bubble','color'),white);
  assert.equal(await style('.messages'),'rgb(247, 249, 252)');
  assert.equal(await style('.sidebar'),'rgb(243, 246, 251)');
  assert.equal(await style('.message.assistant .bubble'),white);
  assert.equal(await style('.session-row.active'),selected);
  assert.ok(contrast(await style('#sendButton','color'),blue)>=4.5);
  assert.ok(contrast(await style('.message-role','color'),await style('.messages'))>=4.5);
  await browser.forcePseudoState('#sendButton',['focus-visible']);
  assert.equal(await style('#sendButton','outlineColor'),'rgb(29, 78, 216)');
  await browser.forcePseudoState('#sendButton',[]);
  await dialog(blue);
  await browser.evaluate("uiDialogConfirm.classList.add('danger');uiDialog.showModal()");
  await browser.waitFor("getComputedStyle(uiDialogConfirm).backgroundColor==='rgb(180, 35, 53)'");
  assert.equal(await style('#uiDialogConfirm'),'rgb(180, 35, 53)');
  await browser.evaluate("uiDialog.close();uiDialogConfirm.classList.remove('danger')");
  await browser.evaluate("window.themeWarning=document.createElement('div');themeWarning.className='skill-collision-row active';document.body.append(themeWarning)");
  assert.equal(await style('.skill-collision-row.active'),'rgb(255, 248, 232)');
  await browser.evaluate("themeWarning.classList.add('skill-collision-conflict')");
  await browser.waitFor("getComputedStyle(themeWarning).backgroundColor==='rgb(255, 240, 237)'");
  assert.equal(await style('.skill-collision-row.active'),'rgb(255, 240, 237)');
  await browser.evaluate('themeWarning.remove()');
  await shot('assistant');
  await browser.evaluate("settingsButton.click();document.querySelector('[data-settings-tab=projectPrompt]').click()");
  await browser.waitFor("settingsDialog.open && document.querySelector('.project-prompt-save')");
  await browser.waitFor("getComputedStyle(document.querySelector('.settings-tabs button.active')).backgroundColor==='rgb(234, 242, 255)'");
  assert.equal(await style('.settings-tabs button.active'),selected);
  assert.equal(await style('.settings-tabs button.active','color'),'rgb(29, 78, 216)');
  assert.equal(await style('.project-prompt-save'),blue);
  await shot('settings');
  t.diagnostic('截图：docs/screenshots/assistant-theme/{home,assistant,settings}.png');
});
