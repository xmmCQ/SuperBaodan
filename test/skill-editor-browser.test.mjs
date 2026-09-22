import test from 'node:test';
import assert from 'node:assert/strict';
import { browserScenario, paint, settingsTab } from './helpers/browser-scenario.mjs';

const skillFixture = `
  const original=fetch;
  let skill={id:'sample-project',name:'sample',scope:'project',writable:true,description:'整理资料与待确认事项',body:'# 工作步骤\\n\\n检查输入资料。\\n列出待确认事项。',content:'---\\nname: sample\\n---\\n正文',filePath:'TEMP/BaodanPark/skills/sample/SKILL.md'};
  window.fetch=(...args)=>{
    const url=String(args[0]),reply=data=>Promise.resolve(new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}}));
    if(url==='/api/skills')return reply({skills:[skill],diagnostics:[],cliAvailable:false});
    if(url==='/api/skills/custom') {const body=JSON.parse(args[1].body);window.savedSkill=body;skill={...skill,description:body.description,body:body.body};return reply({ok:true});}
    return original(...args);
  };
`;

test('技能编辑：描述两行、正文首屏可读、结构化保存重读', {timeout:25000}, async t=>{
  const scenario=await browserScenario(t,{initScript:skillFixture});if(!scenario)return;
  const {browser,navigate,shot}=scenario;await navigate();await settingsTab(browser,'skills');
  await browser.waitFor("document.querySelector('#skillEditBody')");await paint(browser);
  const metrics=await browser.evaluate(`(()=>{const d=document.querySelector('#skillEditDescription'),b=document.querySelector('#skillEditBody'),s=getComputedStyle(b),r=b.getBoundingClientRect(),viewport=document.querySelector('.skills-detail').getBoundingClientRect();return {names:document.querySelectorAll('.skill-editor input[disabled]').length,rows:d.rows,height:d.getBoundingClientRect().height,bodyVisible:Math.min(r.bottom,viewport.bottom)-r.top-parseFloat(s.paddingTop)-parseFloat(s.paddingBottom),line:parseFloat(s.lineHeight),title:document.querySelector('.skill-detail-heading h3').textContent}})()`);
  assert.equal(metrics.names,0);assert.equal(metrics.rows,2);assert.equal(metrics.height,64);assert.equal(metrics.title,'sample');
  assert.ok(metrics.bodyVisible>=metrics.line*2,JSON.stringify(metrics));
  await shot('skill-editor');
  await browser.evaluate("skillEditDescription.value='第一行说明\\n第二行说明';skillEditBody.value='# 新步骤\\n\\n保留完整正文';document.querySelector('[data-action=save-skill]').click()");
  await browser.waitFor("window.savedSkill && document.querySelector('#skillEditDescription')?.value==='第一行说明\\n第二行说明'");
  assert.deepEqual(await browser.evaluate('[savedSkill.name,savedSkill.description,savedSkill.body,skillEditBody.value]'),['sample','第一行说明\n第二行说明','# 新步骤\n\n保留完整正文','# 新步骤\n\n保留完整正文']);
  assert.deepEqual(browser.issues,[]);
});
