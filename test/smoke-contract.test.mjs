import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmokeServer } from './helpers/smoke-server.mjs';
import { createTempProject } from './helpers/temp-project.mjs';
import { TaskStore } from '../app/services/domain/task-store.mjs';
import { registerTaskCommands } from '../app/services/commands/tasks.mjs';
import { buildDayDetails } from '../app/services/domain/tasks.mjs';
import { dispatchSdkCommand } from '../app/services/domain/pi-sdk-commands.mjs';

async function http(fixture, route, body, method = 'POST') {
  const response = await fetch(`http://127.0.0.1:${fixture.port}${route}`, body === undefined ? {signal:AbortSignal.timeout(5000)} : {signal:AbortSignal.timeout(5000),method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok)throw Object.assign(new Error(data.error),{statusCode:response.status});
  return data;
}
const projection = task => Object.fromEntries(['kind','text','checked','plannedDate','dueDate','startDate','endDate'].map(key=>[key,task[key]??null]));

// Shared scenarios, two independent implementations. UI fixtures are not a
// substitute for TaskStore's backup/atomic-write/conflict/path-safety tests.
test('界面任务接口与真实TaskStore命令层遵循相同增改移动删除契约', {timeout:20000}, async t => {
  const fixture=await createSmokeServer();t.after(()=>fixture.close());
  const temp=await createTempProject('task-contract-');t.after(temp.cleanup);
  const taskStore=new TaskStore({todoFile:await temp.write('todo.md','# 工作\n'),backupDir:await temp.ensureDir('backups')});
  const commands=new Map();registerTaskCommands(commands);
  const context={taskStore,dayDetails:buildDayDetails};
  const implementations={
    fixture:{read:date=>http(fixture,`/api/day/${date}`),mutate:(kind,args)=>http(fixture,`/api/tasks${kind==='create'?'':`/${args.id}${kind==='move'?'/move':''}`}`,args,kind==='create'?'POST':kind==='delete'?'DELETE':'PATCH')},
    service:{read:date=>commands.get('tasks.day')({id:date},context),mutate:(kind,args)=>commands.get(`tasks.${kind}`)(args,context)},
  };
  const results=[];
  for(const [name,api] of Object.entries(implementations)) await t.test(name,async()=>{
    let snapshot=await api.read('2026-09-04');const seen=[];
    await assert.rejects(api.mutate('create',{text:'缺少版本',plannedDate:'2026-09-04'}),e=>e.statusCode===400);
    await assert.rejects(api.mutate('create',{revision:'expired',text:'旧版本',plannedDate:'2026-09-04'}),e=>e.statusCode===409);
    const check=result=>{assert.equal(result.ok,true);assert.equal(typeof result.updatedAt,'string');};
    check(await api.mutate('create',{revision:snapshot.updatedAt,kind:'daily',text:'契约任务',plannedDate:'2026-09-04',dueDate:'2026-09-04'}));
    snapshot=await api.read('2026-09-04');seen.push(snapshot.tasks.map(projection));
    check(await api.mutate('update',{revision:snapshot.updatedAt,id:snapshot.tasks[0].id,text:'修改后的契约任务'}));
    snapshot=await api.read('2026-09-04');seen.push(snapshot.tasks.map(projection));
    check(await api.mutate('move',{revision:snapshot.updatedAt,id:snapshot.tasks[0].id,sourceDate:'2026-09-04',targetDate:'2026-09-05'}));
    snapshot=await api.read('2026-09-05');seen.push(snapshot.tasks.map(projection));
    check(await api.mutate('delete',{revision:snapshot.updatedAt,id:snapshot.tasks[0].id}));
    seen.push((await api.read('2026-09-05')).tasks.map(projection));
    assert.deepEqual(seen.at(-1),[]);results.push(seen);
  });
  assert.deepEqual(results[0],results[1]);
});

test('界面模型命令与真实分发器契约一致，不再无条件成功', {timeout:20000}, async t => {
  const fixture=await createSmokeServer();t.after(()=>fixture.close());
  const models=[{provider:'fixture',id:'A'},{provider:'fixture',id:'B'}];
  fixture.state.modelCatalog={models,defaultModel:{provider:'fixture',modelId:'A'},defaultThinkingLevel:'medium',enabledModels:[]};
  const session={sessionId:'seed',model:models[0],thinkingLevel:'medium',messages:[],modelRuntime:{getAvailableSnapshot:()=>models},
    async setModel(model,options){assert.deepEqual(options,{persist:false});this.model=model;},setThinkingLevel(level){this.thinkingLevel=level;}};
  const implementations={fixture:async command=>(await http(fixture,'/api/agent/command',command)).data,
    service:command=>dispatchSdkCommand({promptRuns:new Map()},session,command)};
  for(const [name,command] of Object.entries(implementations))await t.test(name,async()=>{
    for(const sessionId of [undefined,'old-session'])await assert.rejects(command({type:'set_model',sessionId,provider:'fixture',modelId:'B'}),e=>e.statusCode===409);
    const result=await command({type:'set_model',sessionId:'seed',provider:'fixture',modelId:'B'});assert.equal(result.id,'B');
    assert.equal((await command({type:'get_state'})).model.id,'B');
    await command({type:'set_thinking_level',level:'high'});assert.equal((await command({type:'get_state'})).thinkingLevel,'high');
  });
  const fresh=await http(fixture,'/api/agent/new',{});assert.equal(fresh.state.model.id,'A');
  const restored=await http(fixture,'/api/sessions/activate',{path:'/temp/seed.jsonl'});assert.equal(restored.state.model.id,'B');
  assert.equal((await http(fixture,'/api/models/catalog')).defaultModel.modelId,'A');
  await assert.rejects(http(fixture,'/api/agent/command',{type:'unimplemented-command'}),e=>e.statusCode===400);
});
