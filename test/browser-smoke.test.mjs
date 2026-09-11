import test from "node:test";
import assert from "node:assert/strict";
import { edgeAvailable, launchBrowser } from "./helpers/browser-harness.mjs";
import { createSmokeServer } from "./helpers/smoke-server.mjs";

test("六条浏览器主链路使用临时数据和独立端口", { timeout: 20_000 }, async (t) => {
  if (!edgeAvailable()) return t.skip("未安装Microsoft Edge");
  const fixture = await createSmokeServer();
  const browser = await launchBrowser();
  const base = `http://127.0.0.1:${fixture.port}`;
  t.after(async () => { await browser.close(); await fixture.close(); });
  await browser.addInitScript(`
    // The fixture uses 2026-09-04; do not let the real clock select another day.
    const NativeDate = Date;
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : ['2026-09-04T12:00:00'])); }
      static now() { return new NativeDate('2026-09-04T12:00:00').getTime(); }
    };
    for (const name of ['confirm','prompt','alert']) window[name] = () => { throw new Error('禁止调用原生弹窗：' + name); };
  `);

  await t.test("首页完成加载并隐藏loading层", async () => {
    await browser.navigate(`${base}/?smoke=home`);
    await browser.waitFor("document.documentElement.classList.contains('app-ready')");
    const result = await browser.evaluate(`JSON.stringify({
      loading: getComputedStyle(document.querySelector('.app-loading-screen')).display,
      days: document.querySelectorAll('.calendar-day').length,
      workspace: document.querySelector('#workspaceSwitcher').textContent.trim(),
      vskills: document.querySelectorAll('.vskill-chip').length,
      minWidth: getComputedStyle(document.body).minWidth
    })`);
    assert.deepEqual(JSON.parse(result), { loading: "none", days: 42, workspace: "测试工作区", vskills: 1, minWidth: "0px" });
  });

  await t.test("新增、编辑、完成、改期和删除待办", async () => {
    await browser.evaluate(`newTaskButton.click(); taskText.value='冒烟事项'; taskDueDate.value='2026-09-04'; taskForm.requestSubmit()`);
    await browser.waitFor("document.querySelector('#dayTasks')?.innerText.includes('冒烟事项')");
    await browser.evaluate(`document.querySelector('.task-card [data-action="edit"]').click(); taskText.value='已编辑事项'; taskForm.requestSubmit()`);
    await browser.waitFor("document.querySelector('#dayTasks')?.innerText.includes('已编辑事项')");
    await browser.evaluate(`document.querySelector('.task-card [data-action="toggle"]').click()`);
    await browser.waitFor("document.querySelector('.task-card')?.classList.contains('completed')");
    await browser.evaluate(`(() => {
      const card=document.querySelector('.task-card[data-move-kind]');
      const day=document.querySelector('.calendar-day[data-date="2026-09-05"]');
      const transfer=new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));
      day.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      day.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    })()`);
    await browser.waitFor("document.querySelector('#selectedDateTitle')?.textContent.includes('9月5日')");
    await browser.waitFor("document.querySelector('#dayTasks')?.innerText.includes('已编辑事项')");
    await browser.evaluate(`document.querySelector('.task-card [data-action="delete"]').click()`);
    await browser.waitFor("!document.querySelector('#dayTasks')?.innerText.includes('已编辑事项')");
    for (const operation of ["task:create", "task:update", "task:complete", "task:move", "task:delete"]) assert.ok(fixture.state.operations.includes(operation), operation);
  });

  await t.test("每日记录新增、预览、搜索、宝蛋整理和删除", async () => {
    await browser.evaluate("dailyRecordsTab.click()");
    await browser.waitFor("!dailyRecordsPane.classList.contains('hidden')");
    await browser.evaluate(`newDailyRecordButton.click(); dailyRecordTitle.value='票据项目例会'; dailyRecordType.value='meeting'; dailyRecordType.dispatchEvent(new Event('change',{bubbles:true}))`);
    await browser.waitFor("dailyRecordContent.value.includes('会议结论')");
    await browser.evaluate(`dailyRecordTime.value='14:30'; dailyRecordContent.value='## 会议结论\\n\\n确认贴现方案\\n\\n## 后续行动\\n\\n- [ ] 完成冒烟验证'; dailyRecordContent.dispatchEvent(new Event('input',{bubbles:true}))`);
    await browser.waitFor("dailyRecordPreview.innerText.includes('确认贴现方案')");
    await browser.evaluate("dailyRecordForm.requestSubmit()");
    await browser.waitFor("dailyRecordList.innerText.includes('票据项目例会')");
    await browser.waitFor("document.querySelector('.calendar-day[data-date=\"2026-09-05\"] .record-calendar-mark')");
    await browser.evaluate(`document.querySelector('[data-record-action="edit"]').click(); dailyRecordTitle.value='票据项目例会（更新）'; dailyRecordContent.value+='\\n\\n定位关键词'; dailyRecordForm.requestSubmit()`);
    await browser.waitFor("dailyRecordList.innerText.includes('票据项目例会（更新）')");
    await browser.evaluate(`dailyRecordSearch.value='定位关键词'; dailyRecordSearch.dispatchEvent(new Event('input',{bubbles:true}))`);
    await browser.waitFor("dailyRecordSearchStatus.innerText.includes('共找到 1 条')");
    await browser.evaluate(`document.querySelector('[data-record-action="locate"]').click()`);
    await browser.waitFor("dailyRecordSearch.value === '' && selectedDateTitle.innerText.includes('9月5日')");
    await browser.evaluate(`document.querySelector('[data-record-action="toggle"]').click()`);
    await browser.waitFor("document.querySelector('.daily-record-body')?.innerText.includes('定位关键词')");
    await browser.evaluate(`document.querySelector('[data-record-action="send"]').click()`);
    await browser.waitFor("chatMessages.innerText.includes('冒烟回复')");
    const prompt = fixture.state.messages.get(fixture.state.activeSessionId).findLast((message) => message.role === "user")?.content || "";
    assert.match(prompt, /票据项目例会（更新）/);
    assert.match(prompt, /不补充未提供的事实/);
    await browser.evaluate(`document.querySelector('[data-record-action="delete"]').click()`);
    await browser.waitFor("uiDialog.open");
    await browser.evaluate("uiDialogConfirm.click()");
    await browser.waitFor("!dailyRecordList.innerText.includes('票据项目例会（更新）')");
    for (const operation of ["record:create", "record:update", "record:delete", "agent:prompt"]) assert.ok(fixture.state.operations.includes(operation), operation);
  });

  await t.test("助手bootstrap、SSE事件和消息恢复", async () => {
    await browser.navigate(`${base}/assistant.html?smoke=agent`);
    await browser.waitFor("document.querySelector('#modelPickerButton')?.textContent.includes('GPT Test') && document.querySelector('#messages')?.innerText.includes('已恢复的历史回复')");
    assert.equal(await browser.evaluate("runtimeText.textContent"), "");
    assert.equal(await browser.evaluate("runtimeText.closest('.runtime-state').classList.contains('hidden')"), true);
    await browser.evaluate(`promptInput.value='测试SSE'; sendButton.click()`);
    await browser.waitFor("document.querySelector('#messages')?.innerText.includes('冒烟回复')");
    await browser.navigate(`${base}/assistant.html?smoke=recovery`);
    await browser.waitFor("document.querySelector('#messages')?.innerText.includes('冒烟回复')");
    assert.ok(fixture.state.operations.includes("agent:prompt"));
  });

  await t.test("新建、切换、重命名和删除会话", async () => {
    await browser.evaluate("newSession.click()");
    await browser.waitFor("document.querySelectorAll('.session-row').length === 2");
    await browser.evaluate(`document.querySelector('.session-row.active .session-actions button:first-child').click()`);
    await browser.waitFor("document.querySelector('#uiDialog').open");
    await browser.evaluate(`uiDialogField.querySelector('input').value='重命名会话'; uiDialogConfirm.click()`);
    await browser.waitFor("document.querySelector('#sessionList')?.innerText.includes('重命名会话')");
    await browser.evaluate(`document.querySelector('.session-row:not(.active) .session-item').click()`);
    await browser.waitFor("document.querySelector('.session-row.active .session-item')?.innerText.includes('已有对话')");
    await browser.evaluate(`document.querySelector('.session-row.active .session-actions button:last-child').click()`);
    await browser.waitFor("document.querySelector('#uiDialog').open");
    await browser.evaluate("uiDialogConfirm.click()");
    await browser.waitFor("document.querySelectorAll('.session-row').length === 1");
    for (const operation of ["session:create", "session:rename", "session:activate", "session:delete"]) assert.ok(fixture.state.operations.includes(operation), operation);
  });

  await t.test("设置页打开并完成工作区文件上传和预览", async () => {
    await browser.evaluate("settingsButton.click()");
    await browser.waitFor("settingsDialog.open && document.querySelectorAll('#oauthProviders .provider-card').length === 1");
    assert.equal(await browser.evaluate("getComputedStyle(document.body).minWidth"), "1100px");
    await browser.evaluate("closeSettings.click(); showWorkspace.click()");
    await browser.evaluate(`(() => {
      const transfer=new DataTransfer();
      transfer.items.add(new File(['临时文件内容'],'note.txt',{type:'text/plain'}));
      workspaceUploadInput.files=transfer.files;
      workspaceUploadInput.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await browser.waitFor("document.querySelector('#previewTitle')?.textContent === 'note.txt'");
    await browser.waitFor("document.querySelector('#filePreview')?.innerText.includes('临时文件内容')");
    assert.ok(fixture.state.operations.includes("workspace:upload"));
    assert.ok(fixture.state.operations.includes("workspace:preview"));
  });

  assert.deepEqual(browser.issues, []);
});
