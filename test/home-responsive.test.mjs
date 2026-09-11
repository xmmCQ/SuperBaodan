import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeAvailable, launchBrowser } from './helpers/browser-harness.mjs';
import { createSmokeServer } from './helpers/smoke-server.mjs';

test('首页固定基准布局在不同桌面窗口等比例缩放', { timeout: 90000 }, async (t) => {
  if (!edgeAvailable()) return t.skip('未安装 Edge');
  const fixture = await createSmokeServer();
  t.after(() => fixture.close());
  for (let i = 0; i < 50; i++) fixture.state.tasks.push({ id: `responsive-${i}`, text: `待办 ${i}`, editableText: `待办 ${i}`, dueDate: '2026-09-04', roles: [], headingPath: ['测试'] });
  for (const [width, height] of [[1024,768], [1280,720], [1440,900], [1920,1080], [2048,1152], [2560,1440], [3840,2160]]) {
    await t.test(`${width}×${height}`, async () => {
      const browser = await launchBrowser({ width, height });
      try {
        await browser.addInitScript(`const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-09-04T12:00:00']));}};`);
        await browser.navigate(`http://127.0.0.1:${fixture.port}/`);
        await browser.waitFor("document.documentElement.classList.contains('app-ready') && dayTasks.querySelectorAll('.task-card').length === 50");
        const geometry = JSON.parse(await browser.evaluate(`JSON.stringify((() => {
          const rect = s => { const r=document.querySelector(s).getBoundingClientRect(); return { x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom }; };
          return { scale:Number(document.documentElement.dataset.homeScale), canvas:rect('.app-shell'), width:innerWidth, overflow:document.documentElement.scrollWidth > innerWidth+1, cal:rect('.calendar-panel'), day:rect('.day-panel'), chat:rect('.chat-panel'), input:rect('#chatForm'), dayScroll:dayTasks.scrollHeight > dayTasks.clientHeight, spills:[...document.querySelectorAll('.calendar-panel,.day-panel,.chat-panel')].filter(n=>n.scrollWidth>n.clientWidth+1).length };
        })())`));
        assert.equal(geometry.overflow, false, JSON.stringify(geometry));
        assert.equal(geometry.spills, 0, JSON.stringify(geometry));
        assert.ok(geometry.chat.w / geometry.scale >= 359);
        assert.ok(Math.abs(geometry.canvas.w / geometry.scale - 1463) < 2);
        assert.ok(geometry.dayScroll);
        assert.ok(geometry.input.bottom <= geometry.chat.bottom + 1);
        assert.ok(Math.abs(geometry.cal.h - geometry.chat.h) < 2);
        assert.ok(Math.abs(geometry.day.h - geometry.chat.h) < 2);
        assert.ok(geometry.day.x > geometry.cal.x && geometry.chat.x > geometry.day.x);
        await browser.evaluate("document.querySelector('#dayTasks [data-action=edit]').click()");
        await browser.waitFor("!taskModal.classList.contains('hidden')");
        assert.equal(await browser.evaluate("(() => {const r=document.querySelector('.task-modal').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight;})()"), true);
        await browser.evaluate('cancelTaskButton.click()');
      } finally { await browser.close(); }
    });
  }
});
