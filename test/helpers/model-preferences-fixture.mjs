import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PiAdmin } from '../../app/services/domain/pi-admin.mjs';
import { registerModelCommands } from '../../app/services/commands/models.mjs';
import { supportedThinkingLevels } from '../../app/shared/model-preferences.js';

export async function modelPreferencesFixture(root) {
  const agentDir=path.join(root,'model-preference-agent');await mkdir(agentDir,{recursive:true});
  const model=(provider,id,reasoning=true)=>({provider,id,name:`模型 ${id.toUpperCase()}`,reasoning,thinkingLevels:reasoning?['off','medium','high']:['off']});
  const state={models:[model('p','a'),model('p','b'),model('q','c',false),model('p','d')],remote:null,failures:new Set(),networkCalls:0,syncCalls:0,stopCalls:0,writes:[],refreshGate:null};
  const preferencesFile=path.join(agentDir,'settings.json');
  await writeFile(preferencesFile,JSON.stringify({defaultProvider:'p',defaultModel:'a',defaultThinkingLevel:'medium',enabledModels:['p/a','p/b','q/c'],unrelated:'keep'}));
  await writeFile(path.join(agentDir,'auth.json'),JSON.stringify({p:{type:'api_key',key:'isolated-key'},q:{type:'oauth',access:'isolated-access',refresh:'isolated-refresh',expires:Date.now()+3600000}}));
  await writeFile(path.join(agentDir,'models.json'),JSON.stringify({providers:{custom:{models:[{id:'keep-custom',name:'不覆盖'}]}}}));
  const readPreferences=async()=>JSON.parse(await readFile(preferencesFile,'utf8'));
  const runtime={state:'ready',running:true,busyReasons:new Set(),pending:new Map(),host:{session:{sessionId:'seed',model:state.models[1],modelRuntime:{refresh:async options=>{if(options.allowNetwork)throw Error('运行中会话不得联网刷新');state.syncCalls++;}}}},stop:async()=>{state.stopCalls++;throw Error('不得停止当前会话');}};
  const admin=new PiAdmin({agentDir,cwd:root,piRuntime:runtime});
  admin.createSettings=async()=>{
    const data=await readPreferences(),patch={};
    return {getDefaultProvider:()=>data.defaultProvider,getDefaultModel:()=>data.defaultModel,getDefaultThinkingLevel:()=>data.defaultThinkingLevel,getEnabledModels:()=>data.enabledModels,getAllModelThinkingLevels:()=>({}),
      setEnabledModels:value=>{patch.enabledModels=value;},setDefaultModelAndProvider:(provider,id)=>{patch.defaultProvider=provider;patch.defaultModel=id;},setDefaultThinkingLevel:value=>{patch.defaultThinkingLevel=value;},
      flush:async()=>{state.writes.push(Object.keys(patch));await writeFile(preferencesFile,JSON.stringify({...await readPreferences(),...patch}));},drainErrors:()=>[]};
  };
  admin.modelCatalog.thinkingCapabilities=async()=>supportedThinkingLevels;
  admin.createRuntime=async options=>{
    if(options?.allowModelNetwork!==false)throw Error('普通读取必须离线');
    return {getAvailableSnapshot:()=>state.models,getProviders:()=>['p','q','unused'].map(id=>({id,refreshModels(){}})),getProviderAuthStatus:id=>({configured:id!=='unused'}),
      async refresh(options){
        if(!options.allowNetwork || !options.force)throw Error('显式刷新必须指定联网目录请求');
        state.networkCalls++;state.lastProviders=options.providers;if(state.refreshGate)await state.refreshGate;
        if(state.remote)state.models=[...state.models.filter(m=>state.failures.has(m.provider)),...state.remote.filter(m=>!state.failures.has(m.provider))];
        return {aborted:false,errors:new Map([...state.failures].map(id=>[id,new Error(`${id} 模拟目录不可用`)]))};
      }};
  };
  const commands=new Map();registerModelCommands(commands);
  const context={piAdmin:admin,emitAgentEvent() {}};
  return {admin,runtime,state,agentDir,model,readPreferences,command:(name,args={})=>commands.get(name)(args,context),context};
}
