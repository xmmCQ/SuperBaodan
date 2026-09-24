import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempProject } from './helpers/temp-project.mjs';
import { modelPreferencesFixture } from './helpers/model-preferences-fixture.mjs';
import { readonlyCredentials } from '../app/services/domain/model-catalog.mjs';
import { PiAdmin } from '../app/services/domain/pi-admin.mjs';
import { PiSdkRuntime } from '../app/services/domain/pi-sdk.mjs';
import { findSdkEntry } from '../app/services/domain/pi-sdk-factory.mjs';

async function fixture(t) {const temp=await createTempProject('model-preferences-');t.after(temp.cleanup);return modelPreferencesFixture(temp.root);}
test('普通目录读取不联网，刷新部分失败保留旧目录并报告新增和时间',async t=>{
  const f=await fixture(t),before=await f.command('models.catalog');await Promise.all([f.command('models.catalog'),f.command('models.catalog')]);assert.equal(f.state.networkCalls,0);assert.equal(f.state.runtimeCreates,1);
  const auth=await readFile(path.join(f.agentDir,'auth.json')),custom=await readFile(path.join(f.agentDir,'models.json')),prefs=await f.readPreferences();
  f.state.remote=[...f.state.models,f.model('p','e')];f.state.failures.add('q');
  const refreshed=await f.command('models.refresh');
  assert.equal(refreshed.refresh.status,'partial');assert.ok(refreshed.refresh.lastSuccessfulAt);assert.deepEqual(refreshed.newModelKeys,['p/e']);
  assert.ok(refreshed.models.some(m=>m.provider==='q'&&m.id==='c'));assert.match(refreshed.providerResults.find(p=>p.provider==='q').message,/不可用/);
  assert.deepEqual(f.state.lastProviders,['p','q']);assert.equal(f.state.networkCalls,1);
  assert.deepEqual(await f.readPreferences(),prefs);assert.deepEqual(await readFile(path.join(f.agentDir,'auth.json')),auth);assert.deepEqual(await readFile(path.join(f.agentDir,'models.json')),custom);
  f.state.failures.add('p');f.state.remote=[];
  const failed=await f.command('models.refresh');assert.equal(failed.refresh.status,'failed');assert.equal(failed.refresh.lastSuccessfulAt,refreshed.refresh.lastSuccessfulAt);assert.deepEqual(failed.models,refreshed.models);
  assert.equal(f.state.stopCalls,0);assert.equal(f.runtime.host.session.model.id,'b');assert.equal(before.models.length,4);
});
test('目录运行时缓存随配置文件版本失效，不复用旧配置',async t=>{
  const f=await fixture(t);await f.command('models.catalog');const count=f.state.runtimeCreates;
  const file=path.join(f.agentDir,'models.json');await writeFile(file,(await readFile(file,'utf8'))+'\n');
  await f.command('models.catalog');assert.equal(f.state.runtimeCreates,count+1);assert.equal(f.state.networkCalls,0);
});

test('部分显示含旧通配配置时，新增模型也须显式选择，重复读取/刷新不自动勾选',async t=>{
  const f=await fixture(t);await f.command('models.saveDisplay',{enabledModels:['p/*','q/c']});
  const saved=await f.readPreferences();
  f.state.remote=[...f.state.models,f.model('p','e')];
  let catalog=await f.command('models.refresh');assert.equal(catalog.visibleModelKeys.includes('p/e'),false);
  f.state.remote=[...f.state.models,f.model('p','f')];catalog=await f.command('models.refresh');
  assert.equal(catalog.visibleModelKeys.includes('p/e'),false);assert.equal(catalog.visibleModelKeys.includes('p/f'),false);
  assert.deepEqual(await f.readPreferences(),saved);assert.equal((await f.command('models.catalog')).visibleModelKeys.includes('p/e'),false);
  await f.command('models.saveDisplay',{enabledModels:['p/a','p/e','q/c']});
  assert.equal((await f.command('models.catalog')).visibleModelKeys.includes('p/e'),true);
});

test('显示与默认设置按字段保存、默认必须可见、能力合法且不影响现有会话',async t=>{
  const f=await fixture(t),current=f.runtime.host.session.model;
  await f.command('models.saveDisplay',{enabledModels:['p/a','q/c']});
  assert.deepEqual(await f.readPreferences(),{defaultProvider:'p',defaultModel:'a',defaultThinkingLevel:'medium',enabledModels:['p/a','q/c'],unrelated:'keep'});
  await f.command('models.saveDefaults',{defaultModel:{provider:'q',modelId:'c'},defaultThinkingLevel:'off'});
  let prefs=await f.readPreferences();assert.deepEqual(prefs.enabledModels,['p/a','q/c']);assert.equal(prefs.defaultModel,'c');
  await f.command('models.saveDisplay',{enabledModels:['q/c','p/d']});
  prefs=await f.readPreferences();assert.equal(prefs.defaultProvider,'q');assert.equal(prefs.defaultThinkingLevel,'off');
  await assert.rejects(f.command('models.saveDisplay',{enabledModels:['p/a']}),e=>e.statusCode===400);
  await assert.rejects(f.command('models.saveDisplay',{enabledModels:[],defaultThinkingLevel:'high'}),e=>e.statusCode===400);
  await assert.rejects(f.command('models.saveDefaults',{defaultModel:{provider:'p',modelId:'a'},defaultThinkingLevel:'medium'}),e=>e.statusCode===400);
  await assert.rejects(f.command('models.saveDefaults',{defaultModel:{provider:'q',modelId:'c'},defaultThinkingLevel:'high'}),e=>e.statusCode===400);
  await assert.rejects(f.command('models.saveDefaults',{defaultModel:{provider:'q',modelId:'c'},defaultThinkingLevel:'off',enabledModels:[]}),e=>e.statusCode===400);
  assert.deepEqual(f.state.writes,[['enabledModels'],['defaultProvider','defaultModel','defaultThinkingLevel'],['enabledModels']]);
  assert.equal(f.runtime.host.session.model,current);assert.equal(f.state.stopCalls,0);
});
test('忙碌/维护时提示等待；只读凭据禁止刷新写入且不调用OAuth刷新回调',async t=>{
  const f=await fixture(t);f.runtime.busyReasons.add('prompt');
  await assert.rejects(f.command('models.refresh'),e=>e.statusCode===409);assert.equal(f.state.networkCalls,0);assert.equal(f.state.stopCalls,0);
  await assert.rejects(f.command('models.saveDisplay',{enabledModels:[]}),e=>e.statusCode===409);
  const credentials=readonlyCredentials({p:{type:'oauth',access:'fixture',expires:0}});let renewed=false;
  await assert.rejects(credentials.modify('p',()=>{renewed=true;}),/模型配置/);assert.equal(renewed,false);
  const copy=await credentials.read('p');copy.access='changed';assert.equal((await credentials.read('p')).access,'fixture');
  f.runtime.busyReasons.clear();const abort=new AbortController();abort.abort();
  await assert.rejects(f.admin.refreshCatalog({}, {signal:abort.signal}),e=>e.name==='AbortError');assert.equal(f.state.networkCalls,0);
});

test('真实SDK离线目录与默认设置：当前会话不变，新会话读取新默认值', {
  skip:process.platform!=='win32'||process.env.SUPER_BAODAN_TEST_SDK!=='1'||!findSdkEntry(),timeout:40000,
},async t=>{
  const temp=await createTempProject('model-preferences-sdk-');
  const old={offline:process.env.PI_OFFLINE,agent:process.env.PI_CODING_AGENT_DIR};process.env.PI_OFFLINE='1';let runtime;
  t.after(async()=>{await runtime?.close();if(old.offline===undefined)delete process.env.PI_OFFLINE;else process.env.PI_OFFLINE=old.offline;if(old.agent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old.agent;await temp.cleanup();});
  const cwd=await temp.ensureDir('workspace'),agentDir=await temp.ensureDir('agent');
  await temp.writeJson('agent/auth.json',{});
  await temp.writeJson('agent/settings.json',{defaultProvider:'fixture',defaultModel:'first',defaultThinkingLevel:'off',modelThinkingLevels:{'fixture/second':'high','other/model':'low'},enabledModels:['fixture/*'],packages:[]});
  await temp.writeJson('agent/models.json',{providers:{fixture:{api:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',apiKey:'fixture-only',models:['first','second'].map(id=>({id,name:id,reasoning:id==='second',input:['text'],contextWindow:32000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}))}}});
  runtime=new PiSdkRuntime({cwd,agentDir,sessionDir:temp.resolve('sessions'),idleTimeoutMs:600000,log:{warn(){},error(){}}});await runtime.ensureStarted();
  const admin=new PiAdmin({cwd,agentDir,piRuntime:runtime});
  const current=runtime.host.session,chosen=current.model,auth=await readFile(temp.resolve('agent/auth.json')),custom=await readFile(temp.resolve('agent/models.json'));
  const catalog=await admin.catalog();assert.ok(catalog.models.find(m=>m.provider==='fixture'&&m.id==='second').thinkingLevels.includes('medium'));
  await admin.saveDefaultPreferences({defaultModel:{provider:'fixture',modelId:'second'},defaultThinkingLevel:'medium'});
  assert.deepEqual(JSON.parse(await readFile(temp.resolve('agent/settings.json'),'utf8')).enabledModels,['fixture/*']);
  await admin.saveDisplayPreferences({enabledModels:['fixture/second']});
  assert.equal(runtime.host.session,current);assert.equal(current.model,chosen);assert.equal(chosen.id,'first');assert.equal(current.thinkingLevel,'off');
  const fresh=await runtime.newSession();assert.equal(fresh.model.id,'second');assert.equal(fresh.thinkingLevel,'medium');
  assert.deepEqual(JSON.parse(await readFile(temp.resolve('agent/settings.json'),'utf8')).modelThinkingLevels,{'fixture/second':'medium','other/model':'low'});
  assert.deepEqual(await readFile(temp.resolve('agent/auth.json')),auth);assert.deepEqual(await readFile(temp.resolve('agent/models.json')),custom);
});
