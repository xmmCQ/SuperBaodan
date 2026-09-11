import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './helpers/browser-harness.mjs';

test('软件菜单与管理界面增删改、排序、启用和启动，刷新保留配置', { timeout: 20000 }, async t => {
  if (!edgeAvailable()) return t.skip('未安装Microsoft Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await launchBrowser({ width: 1600, height: 1000 });
  const url = `http://127.0.0.1:${fixture.port}/`;
  const open = async () => { await browser.navigate(url); await browser.waitFor("document.documentElement.classList.contains('app-ready')"); await browser.evaluate("openAppsButton.click();document.querySelector('[data-manage-apps]').click()"); await browser.waitFor('workAppsDialog.open'); };
  await open();
  assert.equal(await browser.evaluate("getComputedStyle(workAppsDialog).borderRadius"), '24px');
  assert.equal(await browser.evaluate("getComputedStyle(workAppsDialog.querySelector('.work-app-row')).backgroundColor"), 'rgba(255, 255, 255, 0.22)');
  assert.equal(await browser.evaluate("getComputedStyle(workAppsDialog.querySelector('[data-path]')).backgroundColor"), 'rgba(255, 255, 255, 0.92)');
  for (const selector of ['form', 'fieldset', '.work-app-list', '.modal-actions', '.work-app-notice']) {
    assert.equal(await browser.evaluate(`getComputedStyle(workAppsDialog.querySelector(${JSON.stringify(selector)})).backgroundColor`), 'rgba(0, 0, 0, 0)');
  }
  await browser.evaluate("workAppsDialog.querySelector('[data-add]').click()");
  await browser.evaluate(`(()=>{const row=workAppsDialog.querySelector('.work-app-list').lastElementChild;row.querySelector('[data-name]').value='新软件';row.querySelector('[data-path]').value='D:/Apps/New.exe';row.querySelector('[data-up]').click();workAppsDialog.querySelectorAll('[data-enabled]')[1].checked=false;})()`);
  await browser.evaluate("workAppsDialog.querySelector('[data-run]').click()");
  assert.equal(await browser.evaluate("workAppsDialog.querySelector('.work-app-notice').textContent"), '请先保存配置，再启动软件');
  await browser.evaluate("workAppsDialog.querySelector('form').requestSubmit()");
  await browser.waitFor("workAppsDialog.querySelector('.work-app-notice').textContent==='配置已保存'");
  let saved = await fixture.state.workApps.read(); assert.equal(saved.apps[0].name, '新软件'); assert.equal(saved.apps[1].enabled, false);
  await browser.evaluate("workAppsDialog.querySelector('[data-run]').click()");
  await browser.waitFor("workAppsDialog.querySelector('.work-app-notice').textContent.includes('已发送启动请求')");
  assert.equal(fixture.state.operations.at(-1), `app:open:${saved.apps[0].id}`);
  await browser.evaluate("workAppsDialog.querySelector('[data-close]').click();openAppsButton.click();document.querySelector('[data-open-all]').click()");
  await browser.waitFor("!appsModal.classList.contains('hidden')");
  assert.equal(fixture.state.operations.filter(item => item === 'app:open:fixture').length, 0);
  await open(); assert.equal(await browser.evaluate("workAppsDialog.querySelector('[data-name]').value"), '新软件');
  await browser.evaluate("workAppsDialog.querySelector('[data-name]').value='未保存修改';workAppsDialog.querySelector('[data-close]').click()");
  await browser.waitFor('uiDialog.open'); await browser.evaluate('uiDialogCancel.click()');
  assert.equal(await browser.evaluate('workAppsDialog.open'), true);
  assert.equal(await browser.evaluate("workAppsDialog.querySelector('[data-name]').value"), '未保存修改');
  await browser.evaluate("workAppsDialog.querySelector('[data-delete]').click();workAppsDialog.querySelector('form').requestSubmit()");
  await browser.waitFor("workAppsDialog.querySelector('.work-app-notice').textContent==='配置已保存'");
  saved = await fixture.state.workApps.read(); assert.equal(saved.apps.length, 1); assert.equal(saved.apps[0].id, 'fixture');
  assert.deepEqual(browser.issues, []);
});
