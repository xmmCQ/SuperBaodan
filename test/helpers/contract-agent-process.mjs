import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { serveAgent } from '../../app/agent/process-host.mjs';
import { AgentContext } from '../../app/agent/agent-context.mjs';
import { modelPreferencesFixture } from './model-preferences-fixture.mjs';
import { fault } from '../../app/shared/errors.js';
class FakeRuntime extends EventEmitter {
  constructor(options){super();Object.assign(this,options);this.pending=new Map();this.busyReasons=new Set();this.transitionCount=0;this.state='stopped';this.running=false;this.ui=[];}
  findSdkEntry(){return 'fixture';} isBusy(){return this.busyReasons.size>0;} pendingUiRequests(){return this.ui;}
  snapshot(){return {state:this.host?{sessionId:this.host.session.sessionId,sessionFile:this.activeSessionPath,model:this.host.session.model,thinkingLevel:this.host.session.thinkingLevel,isStreaming:this.isBusy()}: {},messagesVersion:'fixture'};}
  async ensureStarted(file){
    if(this.running)return;
    if(this.cwd.includes('fail-target'))throw fault(500,'fixture target startup failed');
    await mkdir(this.sessionDir,{recursive:true});
    let saved;if(file){const rows=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);saved=rows[0];const model=rows.findLast(row=>row.type==='model_change');if(model)saved.model={provider:model.provider,id:model.modelId};}
    const id=saved?.id || randomUUID();this.activeSessionPath=file || path.join(this.sessionDir,id+'.jsonl');
    if(!file)await writeFile(this.activeSessionPath,JSON.stringify({type:'session',id,cwd:this.cwd,timestamp:new Date().toISOString(),model:{provider:'p',id:'a'}})+'\n');
    this.host={session:{sessionId:id,model:saved?.model || {provider:'p',id:'a'},thinkingLevel:'off',sessionManager:{id},modelRuntime:{refresh:async()=>{}}}};
    this.running=true;this.state='ready';
    if(this.cwd.includes('needs-ui')&&!file){
      const request={type:'extension_ui_request',id:randomUUID(),method:'select',title:'启动交互',options:Array.from({length:40000},(_,i)=>'fixture-option-'+i)};
      this.ui=[request];await new Promise(resolve=>{this.answer=resolve;this.emit('event',request);});this.ui=[];
    }
    this.emit('event',{type:'runtime_ready',state:this.snapshot().state});this.emit('sessions-changed',{file:this.activeSessionPath});
  }
  async send(body){
    if(body.type==='extension_ui_response'){this.answer?.();return null;}
    if(body.type==='get_state')return this.snapshot().state;
    if(body.type==='get_messages')return {messages:[]};
    if(body.type==='get_available_models')return {models:this.catalogState?.models || []};
    if(body.type==='get_available_thinking_levels')return {levels:['off','medium','high']};
    if(body.type==='set_model'){if(body.sessionId!==this.host.session.sessionId)throw fault(409,'会话已变化');this.host.session.model={provider:body.provider,id:body.modelId};await appendFile(this.activeSessionPath,JSON.stringify({type:'model_change',provider:body.provider,modelId:body.modelId})+'\n');return this.host.session.model;}
    if(body.type==='set_thinking_level'){this.host.session.thinkingLevel=body.level;return null;}
    if(body.type==='prompt'){
      await appendFile(this.activeSessionPath,JSON.stringify({type:'message',message:{role:'user',content:body.message}})+'\n');this.emit('sessions-changed',{file:this.activeSessionPath});
      if(body.fixture==='crash-after-write')process.exit(19);
      if(body.fixture==='busy'){this.busyReasons.add('work');this.state='busy';this.emit('event',{type:'agent_start'});}
      return null;
    }
    if(body.type==='abort'){this.answer?.();this.busyReasons.clear();this.state='ready';this.emit('event',{type:'agent_settled'});return null;}
    return null;
  }
  async newSession(){await this.stop();await this.ensureStarted();return this.snapshot().state;}
  async openSession(file){await this.stop();await this.ensureStarted(file);return this.snapshot().state;}
  async renameSession(file,name){await appendFile(file,JSON.stringify({type:'session_info',name})+'\n');this.emit('sessions-changed',{file});return {renamed:true};}
  async deleteSession(file){const active=file===this.activeSessionPath;if(active)await this.newSession();await unlink(file);this.emit('sessions-changed',{file});return {deleted:true,activeDeleted:active,state:this.snapshot().state};}
  async updateProjectPrompt(save){const value=await save();return {...value,applied:true};}
  beginShutdown(){this.answer?.();this.ui=[];return Promise.resolve();}
  async stop(){this.running=false;this.state='stopped';}
  async close(){await this.beginShutdown();await this.stop();this.closed=true;this.host=null;}
}
class ContractContext extends AgentContext {
  async makeServices(workspace,epoch){
    const service=await super.makeServices(workspace,epoch);
    const fixture=await modelPreferencesFixture(path.join(this.config.piAgentDir,workspace.id));
    fixture.admin.piRuntime=service.runtime;service.runtime.catalogState=fixture.state;
    const original=fixture.admin.createRuntime;
    fixture.admin.createRuntime=async(options={})=>({...await original({allowModelNetwork:false,...options}),getProvider:()=>({auth:{oauth:{}}}),login:async(_id,_type,options)=>{await options.prompt({type:'manual_code',message:'输入测试授权码'});}});
    service.admin=fixture.admin;
    service.skills={list:async()=>({skills:[{id:'collision',name:'示例',collision:{kind:'conflict'}}],diagnostics:[],cliAvailable:false}),createCustom:async body=>({skill:body}),setInvocation:async body=>({skill:body})};
    return service;
  }
}
serveAgent({createContext:(config,dependencies)=>new ContractContext(config,{...dependencies,createRuntime:options=>new FakeRuntime(options)})});
