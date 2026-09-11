import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './helpers/browser-harness.mjs';

test('一键互转不弹确认，保留选中项；分组独立折叠、持久化，搜索展开', { timeout: 25000 }, async t => {
  if (!edgeAvailable()) return t.skip('需要 Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await launchBrowser({ width: 1600, height: 1000 });
  await browser.addInitScript(`
    const make=(name,scope,writable=true)=>({id:name+'-'+scope,name,scope,writable,revision:'test-revision',description:'测试',body:'正文',content:'测试全文',filePath:scope+'/'+name+'/SKILL.md'});
    const list=[make('demo','global'),make('stay','global'),make('local','project'),make('readonly','other',false)];
    window.moves=[];window.openedSkills=[];const original=fetch;
    window.fetch=(...args)=>{
      const url=String(args[0]);
      if(url==='/api/skills')return Promise.resolve(new Response(JSON.stringify({skills:list,diagnostics:[],cliAvailable:false}),{headers:{'Content-Type':'application/json'}}));
      if(url==='/api/skills/open-directory'){openedSkills.push(JSON.parse(args[1].body));return Promise.resolve(new Response(JSON.stringify({opened:true}),{headers:{'Content-Type':'application/json'}}));}
      if(url==='/api/skills/transfer'){
        const payload=JSON.parse(args[1].body);moves.push(payload);
        const skill=list.find(s=>s.id===payload.id);skill.scope=skill.scope==='global'?'project':'global';skill.id=skill.name+'-'+skill.scope;skill.filePath=skill.scope+'/'+skill.name+'/SKILL.md';
        return Promise.resolve(new Response(JSON.stringify({ok:true,moved:true,scope:skill.scope,skillId:skill.id}),{headers:{'Content-Type':'application/json'}}));
      }
      return original(...args);
    };
  `);
  const open = async () => {
    await browser.navigate(`http://127.0.0.1:${fixture.port}/assistant.html`);
    await browser.waitFor("document.querySelectorAll('#messages > .message').length>=2");
    await browser.evaluate("settingsButton.click();document.querySelector('[data-settings-tab=skills]').click()");
    await browser.waitFor("document.querySelectorAll('.skill-list-item').length===4");
  };
  await open();
  const dialogCount = await browser.evaluate("document.querySelectorAll('dialog[open]').length");
  assert.equal(await browser.evaluate("document.querySelectorAll('.skill-list-actions [data-action=delete-skill]').length"), 3);
  assert.equal(await browser.evaluate("document.querySelectorAll('.skill-detail-controls .skill-heading-actions button').length"), 2);
  assert.equal(await browser.evaluate("document.querySelector('.skill-heading-actions').getBoundingClientRect().top >= document.querySelector('.skill-invocation-toggle').getBoundingClientRect().bottom"), true);
  await browser.evaluate("[...document.querySelectorAll('.skill-list-item')].find(r=>r.textContent.includes('readonly')).querySelector('[data-action=open-skill-directory]').click()");
  await browser.waitFor('openedSkills.length===1');
  assert.equal(await browser.evaluate('openedSkills[0].id'), 'readonly-other');
  assert.equal(await browser.evaluate('openedSkills[0].workspaceId'), 'test-workspace');
  assert.equal(await browser.evaluate("document.querySelector('#skillsDetail h3').textContent"), 'demo');
  assert.equal(await browser.evaluate("Boolean(document.querySelector('.skill-editor [data-action=save-skill]'))"), false);
  // Unsaved edits block moving without a confirmation dialog or silent discard.
  await browser.evaluate("skillEditBody.value='未保存';document.querySelector('[data-action=transfer-skill]').click()");
  assert.equal(await browser.evaluate('moves.length'), 0);
  assert.equal(await browser.evaluate('skillEditBody.value'), '未保存');
  await browser.evaluate("skillEditBody.value='正文';document.querySelector('[data-action=transfer-skill]').click()");
  await browser.waitFor("moves.length===1&&document.querySelector('#skillsDetail h3')?.textContent==='demo'&&document.querySelector('[data-action=transfer-skill]')?.textContent==='提升为全局'");
  assert.equal(await browser.evaluate('moves[0].workspaceId'), 'test-workspace');
  assert.equal(await browser.evaluate("document.querySelectorAll('dialog[open]').length"), dialogCount);
  await browser.evaluate("document.querySelector('[data-action=transfer-skill]').click()");
  await browser.waitFor("moves.length===2&&document.querySelector('[data-action=transfer-skill]')?.textContent==='移入当前项目'");
  await browser.evaluate("document.querySelector('.skill-group[data-scope=global] summary').click()");
  await browser.waitFor("JSON.parse(localStorage.getItem('super-baodan.skill-groups.v1')).global===true");
  assert.equal(await browser.evaluate("document.querySelector('.skill-group[data-scope=project]').open"), true);
  await open();
  assert.equal(await browser.evaluate("document.querySelector('.skill-group[data-scope=global]').open"), false);
  await browser.evaluate("skillsFilter.value='demo';skillsFilter.dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await browser.evaluate("document.querySelector('.skill-group[data-scope=global]').open"), true);
  await browser.evaluate("skillsFilter.value='';skillsFilter.dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await browser.evaluate("document.querySelector('.skill-group[data-scope=global]').open"), false);
  await browser.evaluate("[...document.querySelectorAll('.skill-list-item')].find(r=>r.textContent.includes('readonly')).click()");
  assert.equal(await browser.evaluate("Boolean(document.querySelector('[data-action=transfer-skill]'))"), false);
  assert.deepEqual(browser.issues, []);
});
