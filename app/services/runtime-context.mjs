import { TaskStore } from './domain/task-store.mjs';
import { DailyRecordManager } from './domain/daily-record-manager.mjs';
import { VSkillManager } from './domain/vskill-manager.mjs';
import { WorkspaceRegistry, samePath } from './domain/workspace-registry.mjs';
import { WorkspaceService } from './domain/workspace.mjs';
import { WorkDocuments } from './domain/work-documents.mjs';
import { WorkApps } from './domain/work-apps.mjs';
import { launchWorkApps } from './domain/launch-work-apps.mjs';
import { listSavedSessions, invalidateSavedSession } from './domain/pi-session-store.mjs';
import { boundBrowserAgentEvent } from './domain/pi-sdk-ui.mjs';
import { buildDashboard, buildDayDetails, localDateString } from './domain/tasks.mjs';
import { captureWorkspace, assertWorkspaceSnapshot, enqueueWorkspaceOperation } from './workspace-operations.mjs';
import { isControlRequest } from '../shared/agent-protocol.js';
import { fault } from '../shared/errors.js';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function createRuntimeContext(config) { const context=new RuntimeContext(config);await context.initialize();return context; }
export class RuntimeContext {
  constructor(config) {
    this.config=config;this.agent=config.agentClient;this.emitEvent=config.emitEvent || (()=>{});
    this.taskStore=new TaskStore({todoFile:config.todoFile,backupDir:config.backupDir});
    this.dailyRecordManager=new DailyRecordManager({filePath:config.dailyRecordFile,backupDir:config.backupDir});
    this.vskillManager=new VSkillManager({filePath:config.vskillFile,backupDir:config.backupDir});
    this.workspaceRegistry=new WorkspaceRegistry({filePath:config.workspaceFile,backupDir:config.backupDir,defaultRoot:config.workspaceDir,prepareLayout:false,log:console});
    this.workDocuments=new WorkDocuments({filePath:config.workDocumentsFile || path.join(path.dirname(config.todoFile),'work-documents.json')});
    this.workApps=new WorkApps({filePath:config.workAppsFile || path.join(path.dirname(config.todoFile),'work-apps.json'),launch:config.desktopControlled?async apps=>({launchApps:apps}):apps=>launchWorkApps(apps,{appScript:config.appScript})});
    this.workspaceSwitchQueue=Promise.resolve();this.workspaceEpoch=0;this.workspaceSwitching=false;this.shuttingDown=false;
    this.turnFiles={involved:[],modified:[]};this.cancelledLogins=new Set();
    this.agent?.on('event',message=>this.agentEvent(message));
    this.agent?.on('status',(state,previous)=>this.agentStatus(state,previous));
  }
  async initialize() {
    const initialized=await Promise.allSettled([mkdir(this.config.backupDir,{recursive:true}),this.dailyRecordManager.initialize(),this.vskillManager.initialize(),this.workspaceRegistry.initialize()]);
    const failure=initialized.find(item=>item.status==='rejected');if(failure)throw failure.reason;
    this.activeWorkspace=this.workspaceRegistry.active();this.workspaceService=await new WorkspaceService(this.activeWorkspace.canonicalRoot).initialize();
  }
  assertActiveWorkspace(id){if(id&&id!==this.activeWorkspace?.id)throw fault(409,'工作区已切换，请刷新后重试');}
  publicWorkspace(item){return {id:item.id,name:item.name,root:item.root,isDefault:Boolean(item.isDefault),available:item.available!==false,lastUsedAt:item.lastUsedAt};}
  async publicWorkspaceList(){const list=await this.workspaceRegistry.list();return {activeWorkspaceId:list.activeWorkspaceId,items:list.items.map(item=>this.publicWorkspace(item)),warning:this.workspaceRegistry.fallbackWarning};}
  async listActiveSessions(_unused,workspace=this.activeWorkspace){return (await listSavedSessions(this.config.piSessionDir)).filter(item=>item.cwd&&samePath(item.cwd,workspace.canonicalRoot));}
  async assertSessionInActiveWorkspace(file,workspace=this.activeWorkspace){const item=(await this.listActiveSessions(null,workspace)).find(item=>samePath(item.path,file));if(!item)throw fault(403,'该会话不属于当前工作区');return item;}
  scope(){return {workspaceId:(this.transition?.workspace || this.activeWorkspace)?.id,workspaceEpoch:this.transition?.epoch ?? this.workspaceEpoch};}
  async ensureAgent(snapshot,{retry=false,signal}={}) {
    if(!this.agent)throw fault(503,'Agent通道不可用');
    await this.agent.ensureConnected(retry);assertWorkspaceSnapshot(this,snapshot);
    const sessions=await this.listActiveSessions(null,snapshot.workspace);assertWorkspaceSnapshot(this,snapshot);
    const remembered=sessions.find(item=>item.id===snapshot.workspace.lastSessionId);
    await this.agent.configure({workspace:snapshot.workspace,epoch:snapshot.epoch,resumePath:remembered?.path || null},{signal});
    assertWorkspaceSnapshot(this,snapshot);
  }
  async rememberSessionFromState(state,snapshot) {
    assertWorkspaceSnapshot(this,snapshot);if(!state?.sessionId)return;
    await this.workspaceRegistry.rememberSession(snapshot.workspace.id,state.sessionId);this.activeWorkspace=this.workspaceRegistry.active();
  }
  forwardAgent(name,args={},signal) {
    if(name==='agent.receipt') {
      if(!this.agent?.receiptKnown(args.requestId))return Promise.resolve({status:'unknown'});
      return this.agent.invoke(name,args,{scope:this.scope(),signal}).catch(()=>({status:'unknown'}));
    }
    if(name==='auth.cancel'){
      this.cancelledLogins.add(args.subscriptionId);if(this.cancelledLogins.size>128)this.cancelledLogins.delete(this.cancelledLogins.values().next().value);
      if(this.agent?.snapshot.processState!=='connected')return Promise.resolve({ok:true});
    }
    if(isControlRequest(name,args)) {
      if(!this.agent)throw fault(503,'Agent通道不可用');
      return this.agent.invoke(name,args,{scope:this.scope(),signal});
    }
    const snapshot=captureWorkspace(this,args.workspaceId);
    if(name==='auth.start')this.authSubscriptionId=args.subscriptionId;
    const run=async()=>{
      if(signal?.aborted)throw fault(499,'操作已取消');
      assertWorkspaceSnapshot(this,snapshot);await this.ensureAgent(snapshot,{retry:name==='agent.start'&&args.retry===true,signal});
      if(name==='auth.start'&&this.cancelledLogins.has(args.subscriptionId))return {ok:true,cancelled:true};
      const ownedSession=name.startsWith('sessions.')?await this.assertSessionInActiveWorkspace(args.path,snapshot.workspace):null;
      const result=await this.agent.invoke(name,args,{scope:{workspaceId:snapshot.workspace.id,workspaceEpoch:snapshot.epoch},signal});
      assertWorkspaceSnapshot(this,snapshot);
      if(name==='sessions.delete'&&this.workspaceRegistry.active().lastSessionId===ownedSession.id){await this.workspaceRegistry.setActive(snapshot.workspace.id,null);this.activeWorkspace=this.workspaceRegistry.active();}
      if(['agent.bootstrap','agent.new','agent.start','sessions.activate','sessions.delete'].includes(name))await this.rememberSessionFromState(result.state || (name==='agent.start'?this.agent.snapshot.session:null),snapshot);
      if(['agent.new','sessions.activate'].includes(name))this.clearTurnFiles();
      if(name==='agent.bootstrap')return {...result,sessions:await this.listActiveSessions(),workspace:this.publicWorkspace(this.activeWorkspace),workspaces:await this.publicWorkspaceList(),turnFiles:result.turnFiles || this.turnFileSnapshot()};
      return result;
    };
    return ['agent.start','agent.bootstrap','agent.snapshot','agent.new','sessions.activate','sessions.rename','sessions.delete','projectPrompt.save'].includes(name)?enqueueWorkspaceOperation(this,run):run();
  }
  agentConnection() {
    const value=this.agent?.snapshot || {};
    return [{type:'connected',running:Boolean(value.running),state:value.state || 'stopped',idleTimeoutMs:value.idleTimeoutMs,workspace:this.publicWorkspace(this.activeWorkspace)},...(value.pendingUi || []),...((value.processState==='failed'||value.state==='error')?[{type:'runtime_exit',phase:'agent_process',error:value.error || '助手已断开，请重试'}]:[])];
  }
  agentStatus(state,previous) {
    if(this.shuttingDown)return;
    if(state.processState==='failed'||state.state==='error'){
      this.emitAgentEvent({type:'runtime_exit',phase:'agent_process',error:state.error || '助手已断开，请重试'});
      if(this.authSubscriptionId)this.emitEvent('auth',{type:'cancelled',subscriptionId:this.authSubscriptionId,message:'助手已断开，请重试登录'});
      this.authSubscriptionId=null;
    }
  }
  agentEvent({topic,event,scope}) {
    if(this.shuttingDown)return;
    const expected=this.scope();
    if(scope?.workspaceId!==expected.workspaceId||scope?.workspaceEpoch!==expected.workspaceEpoch)return;
    if(event.type==='sessions_invalidated'){try{invalidateSavedSession(this.config.piSessionDir,event.file);}catch{}return;}
    if(this.workspaceSwitching&&event.type!=='extension_ui_request'&&event.type!=='extension_ui_payload'&&topic!=='auth')return;
    if(topic==='agent'){
      if(event.type==='agent_start')this.turnFiles={involved:[],modified:[]};
      if(event.type==='workspace_turn_files')this.turnFiles={involved:event.involved || [],modified:event.modified || []};
      if(event.type==='runtime_ready'&&event.state?.sessionId){const snapshot=captureWorkspace(this);void enqueueWorkspaceOperation(this,()=>this.rememberSessionFromState(event.state,snapshot)).catch(()=>{});}
    }
    this.emitEvent(topic,event);
  }
  async operationState(operationId,scope) {
    return this.agent.invoke('control.operation',{operationId},{scope,timeout:5000});
  }
  activateWorkspace(id) {
    return enqueueWorkspaceOperation(this,async()=>{
      if(this.agent?.snapshot.processState==='failed')throw fault(503,'请先重试助手，再切换工作区');
      const target=await this.workspaceRegistry.validateRegistered(id);
      if(id===this.activeWorkspace.id)return {workspace:this.publicWorkspace(this.activeWorkspace),sessions:await this.listActiveSessions()};
      const before=captureWorkspace(this);await this.ensureAgent(before);
      const files=await new WorkspaceService(target.canonicalRoot).initialize();
      const sessions=await this.listActiveSessions(null,target),resumePath=sessions.find(item=>item.id===target.lastSessionId)?.path || null;
      const operationId=randomUUID(),epoch=++this.workspaceEpoch;let committed=false;
      this.workspaceSwitching=true;this.transition={workspace:target,epoch};
      const scope=this.scope();
      try {
        let prepared;
        try{prepared=await this.agent.invoke('control.prepareWorkspace',{operationId,workspace:target,epoch,resumePath},{scope});}
        catch(error){
          if([408,499,503].includes(error.statusCode)){const status=await this.operationState(operationId,scope);if(status.status==='prepared')prepared=status;else throw error;}else throw error;
        }
        if(prepared.status!=='prepared')throw fault(503,'无法确认Agent切换结果');
        this.activeWorkspace=await this.workspaceRegistry.setActive(target.id,prepared.result.state?.sessionId || null);committed=true;this.workspaceService=files;
        this.clearTurnFiles();this.emitAgentEvent({type:'workspace_changed',workspace:this.publicWorkspace(this.activeWorkspace)});
        try{await this.agent.invoke('control.commitWorkspace',{operationId,epoch},{scope});}
        catch(error){const status=await this.operationState(operationId,scope);if(status.status!=='committed')throw error;}
        this.agent.adoptScope(this.activeWorkspace,this.workspaceEpoch);
        this.emitAgentEvent({type:'runtime_ready',state:prepared.result.state});
        return {workspace:this.publicWorkspace(this.activeWorkspace),sessions,state:prepared.result.state};
      }catch(error){
        if(!committed&&!this.shuttingDown){
          const rollbackEpoch=++this.workspaceEpoch;this.transition={workspace:before.workspace,epoch:rollbackEpoch};
          try{
            const restored=await this.agent.invoke('control.rollbackWorkspace',{operationId,epoch:rollbackEpoch},{scope:this.scope()});
            this.agent.adoptScope(before.workspace,rollbackEpoch);
            this.emitAgentEvent({type:'runtime_ready',state:restored.result?.state});
          }catch(rollbackError){
            let status;try{status=await this.operationState(operationId,this.scope());}catch{}
            if(status?.status!=='rolledBack')this.agent.markUnavailable('工作区切换结果无法确认，登记未改变；请重试助手');
          }
        }else if(committed)this.agent.markUnavailable('工作区已登记，助手断开；重试将按已登记工作区恢复');
        throw error;
      }finally{this.workspaceSwitching=false;this.transition=null;}
    });
  }
  emitAgentEvent(event){this.emitEvent('agent',boundBrowserAgentEvent(event));}
  turnFileSnapshot(){return structuredClone(this.turnFiles);}
  clearTurnFiles(){this.turnFiles={involved:[],modified:[]};this.emitAgentEvent({type:'workspace_turn_files',...this.turnFiles});}
  dashboard(tasks,month){return buildDashboard(tasks,{month});}
  dayDetails(tasks,date){return buildDayDetails(tasks,date);}
  today(){return localDateString();}
  beginShutdown(){this.shuttingDown=true;this.agent?.close();return Promise.resolve();}
  shutdown(requests=[]) {
    if(this.shutdownPromise)return this.shutdownPromise;this.beginShutdown();for(const request of requests)request.controller?.abort();
    this.shutdownPromise=(async()=>{
      await Promise.allSettled(requests.map(request=>request.task));
      await Promise.allSettled([this.taskStore.whenIdle(),this.dailyRecordManager.mutationTail,this.vskillManager.mutationTail,this.workspaceRegistry.queue,this.workApps.queue,this.workDocuments.queue,this.workspaceSwitchQueue]);
    })();return this.shutdownPromise;
  }
}
