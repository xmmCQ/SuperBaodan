import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createTempProject } from './helpers/temp-project.mjs';
import { readProjectPrompt, saveProjectPrompt } from '../lib/project-prompt.mjs';
import { sdkHarness, deferred, wait } from './helpers/fake-sdk-host.mjs';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './helpers/browser-harness.mjs';

test('项目根目录提示词创建、版本冲突、备份、空内容及编码大小校验', async t => {
  const temp = await createTempProject('project-prompt-'); t.after(() => temp.cleanup());
  await temp.ensureDir('project'); await temp.ensureDir('other');
  const root = temp.resolve('project'), backups = temp.resolve('backups');
  const missing = await readProjectPrompt(root); assert.equal(missing.exists, false);
  const first = await saveProjectPrompt(root, { content: '# 项目规则\n使用中文', revision: missing.revision }, backups);
  assert.equal(first.exists, true); assert.equal((await readProjectPrompt(temp.resolve('other'))).exists, false);
  await assert.rejects(saveProjectPrompt(root, { content: '旧页面', revision: missing.revision }, backups), { statusCode: 409 });
  const empty = await saveProjectPrompt(root, { content: '', revision: first.revision }, backups); assert.equal(empty.content, '');
  const files = await fs.readdir(backups); assert.equal(await fs.readFile(`${backups}/${files[0]}`, 'utf8'), first.content);
  await assert.rejects(saveProjectPrompt(root, { content: 'x'.repeat(128 * 1024 + 1), revision: empty.revision }, backups));
  await fs.writeFile(first.path, Buffer.from([0xff, 0xfe])); await assert.rejects(readProjectPrompt(root), { statusCode: 409 });
});

test('运行时保存后重载同一会话，忙时不写入，失败清理且不误报生效', async () => {
  const h = await sdkHarness();
  try {
    await h.runtime.start(); const session = h.runtime.host.session; let reloads = 0, writes = 0;
    session.reload = async () => { reloads++; };
    assert.equal((await h.runtime.updateProjectPrompt(async () => { writes++; return { revision: 'one' }; })).applied, true);
    assert.equal(h.runtime.host.session, session); assert.equal(reloads, 1);
    h.runtime.setBusy('fixture', true);
    await assert.rejects(h.runtime.updateProjectPrompt(async () => { writes++; }), { statusCode: 409 }); assert.equal(writes, 1);
    h.runtime.setBusy('fixture', false);
    const gate = deferred(); session.reload = () => gate.promise;
    const saving = h.runtime.updateProjectPrompt(async () => ({ revision: 'two' })); await wait(5);
    await assert.rejects(h.runtime.send({ type: 'prompt', message: 'cannot race save' }), { statusCode: 409 });
    gate.resolve(); await saving;
    session.reload = async () => { throw new Error('fixture reload failed'); };
    const failed = await h.runtime.updateProjectPrompt(async () => ({ revision: 'saved' }));
    assert.equal(failed.applied, false); assert.equal(failed.revision, 'saved'); assert.equal(h.runtime.running, false);
  } finally { await h.cleanup(); }
});

test('设置项目提示词：新建保存、未保存确认、运行中拒绝保留草稿', { timeout: 20000 }, async t => {
  if (!edgeAvailable()) return t.skip('未安装Microsoft Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await launchBrowser({ width: 1600, height: 1000 });
  await browser.navigate(`http://127.0.0.1:${fixture.port}/assistant.html`);
  await browser.waitFor("document.querySelector('#workspaceSwitcher').textContent.includes('测试工作区')");
  await browser.evaluate("settingsButton.click();document.querySelector('[data-settings-tab=projectPrompt]').click()");
  await browser.waitFor("document.querySelector('.project-prompt-status').textContent.includes('尚未创建')");
  await browser.evaluate("document.querySelector('.project-prompt-editor').value='项目规则：中文回答';document.querySelector('.project-prompt-save').click()");
  await browser.waitFor("document.querySelector('.project-prompt-status').textContent.includes('已保存并生效')");
  assert.equal((await readProjectPrompt(fixture.state.projectRoot)).content, '项目规则：中文回答');
  await browser.evaluate("document.querySelector('.project-prompt-editor').value='尚未保存的规则';closeSettings.click()");
  await browser.waitFor('uiDialog.open'); await browser.evaluate('uiDialogCancel.click()');
  assert.equal(await browser.evaluate('settingsDialog.open'), true);
  fixture.state.projectPromptBusy = true;
  await browser.evaluate("document.querySelector('.project-prompt-save').click()");
  await browser.waitFor("document.querySelector('.project-prompt-status').textContent.includes('任务正在执行')");
  assert.equal(await browser.evaluate("document.querySelector('.project-prompt-editor').value"), '尚未保存的规则');
  assert.equal((await readProjectPrompt(fixture.state.projectRoot)).content, '项目规则：中文回答');
  await browser.evaluate("document.querySelector('.project-prompt-editor').value='项目规则：中文回答';closeSettings.click()");
  assert.deepEqual(browser.issues, []);
});
