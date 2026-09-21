import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { launchBrowser, edgeAvailable } from './helpers/browser-harness.mjs';

test('技能列表突出双方重复/冲突，展示路径，删除前可确认具体副本', { timeout: 25000 }, async t => {
  if (!edgeAvailable()) return t.skip('需要 Edge');
  const fixture = await createSmokeServer(); let browser;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await launchBrowser({ width: 1600, height: 1000 });
  await browser.addInitScript(`
    localStorage.setItem('super-baodan.skill-groups.v1',JSON.stringify({global:true,project:true}));
    const make=(name,scope)=>({id:name+'-'+scope,name,scope,writable:true,description:'说明',body:'正文',content:'完整正文',filePath:scope+'/'+name+'/SKILL.md',loadState:scope==='global'?'selected':'shadowed'});
    let list=[make('same','global'),make('same','project'),make('different','global'),make('different','project')];
    for(const skill of list)skill.collision={kind:skill.name==='same'?'duplicate':'conflict',peers:list.filter(s=>s.name===skill.name&&s!==skill).map(s=>({id:s.id,scope:s.scope,filePath:s.filePath,loadState:s.loadState}))};
    window.skillMutations=[];const original=fetch;
    window.fetch=(...args)=>{
      const url=String(args[0]);
      const reply=body=>Promise.resolve(new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}}));
      if(url==='/api/skills')return reply({skills:list,diagnostics:[],cliAvailable:false});
      if(url==='/api/skills/custom'){
        const payload=JSON.parse(args[1].body);skillMutations.push({method:args[1].method,...payload});
        if(args[1].method==='DELETE'){
          list=list.filter(s=>!(s.name===payload.name&&s.scope===payload.scope));
          for(const skill of list)if(skill.name===payload.name)delete skill.collision;
        }
        return reply({ok:true});
      }
      return original(...args);
    };
  `);
  await browser.navigate(`http://127.0.0.1:${fixture.port}/assistant.html`);
  await browser.waitFor("document.querySelectorAll('#messages > .message').length>=2");
  await browser.evaluate("settingsButton.click();document.querySelector('[data-settings-tab=skills]').click()");
  await browser.waitFor("document.querySelectorAll('.skill-collision-row').length===4");
  assert.equal(await browser.evaluate("document.querySelectorAll('.skill-collision-row.skill-collision-duplicate').length"), 2);
  assert.equal(await browser.evaluate("document.querySelectorAll('.skill-collision-row.skill-collision-conflict').length"), 2);
  assert.equal(await browser.evaluate("[...document.querySelectorAll('.skill-group')].every(g=>g.open)"), true);
  assert.equal(await browser.evaluate("[...document.querySelectorAll('.skill-collision-label')].filter(n=>n.textContent.includes('未选用')).length"), 2);
  await browser.evaluate("document.querySelector('[data-skill-id=same-project] .skill-list-select').click()");
  assert.ok((await browser.evaluate("document.querySelector('.skill-collision-note').textContent")).includes('global/same/SKILL.md'));
  assert.equal(await browser.evaluate("Boolean(document.querySelector('#skillEditBody'))"), true);
  await browser.evaluate("document.querySelector('[data-skill-id=same-project] [data-action=delete-skill]').click()");
  await browser.waitFor('uiDialog.open');
  assert.ok((await browser.evaluate('uiDialogMessage.textContent')).includes('project/same/SKILL.md'));
  await browser.evaluate('uiDialogCancel.click()');
  assert.equal(await browser.evaluate('skillMutations.length'), 0);
  await browser.evaluate("document.querySelector('[data-skill-id=same-project] [data-action=delete-skill]').click()");
  await browser.waitFor('uiDialog.open'); await browser.evaluate('uiDialogConfirm.click()');
  await browser.waitFor("document.querySelectorAll('.skill-list-item').length===3");
  assert.equal(await browser.evaluate('skillMutations[0].scope'), 'project');
  assert.equal(await browser.evaluate("Boolean(document.querySelector('[data-skill-id=same-global]'))"), true);
  assert.equal(await browser.evaluate("document.querySelectorAll('.skill-collision-row').length"), 2);
  assert.deepEqual(browser.issues, []);
});
