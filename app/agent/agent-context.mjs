import { PiSdkRuntime } from '../services/domain/pi-sdk.mjs';
import { PiAdmin } from '../services/domain/pi-admin.mjs';
import { SkillManager } from '../services/domain/skill-manager.mjs';
import { normalizeWorkspaceToolPath } from '../services/domain/workspace.mjs';
import { prepareWorkspace } from '../services/domain/workspace-layout.mjs';
import { validateWorkspaceSettings } from '../services/domain/workspace-resources.mjs';
import { saveProjectPrompt } from '../services/domain/project-prompt.mjs';
import { assertSessionPath, readSessionMetadata, sameSessionPath } from '../services/domain/pi-session-store.mjs';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PromptReceipts } from '../services/prompt-receipts.mjs';
import { UiEventPayloads, MAX_UI_RESPONSE_BYTES } from '../services/ui-event-payloads.mjs';
import { boundBrowserAgentEvent, MAX_BROWSER_EVENT_BYTES } from '../services/domain/pi-sdk-ui.mjs';
import { assertAllowedAgentCommand } from '../services/domain/agent-commands.mjs';
import { validatePromptPayload } from '../shared/prompt-images.js';
import { fault, publicErrorMessage } from '../shared/errors.js';
import { registerAuthCommands } from '../services/commands/auth.mjs';
import { registerModelCommands } from '../services/commands/models.mjs';
import { registerSkillCommands } from '../services/commands/skills.mjs';

export class AgentContext {
  constructor(config,{emit=()=>{},publish=()=>{},createRuntime=options=>new PiSdkRuntime(options),normalizeToolPath=normalizeWorkspaceToolPath}={}) {
    this.config=config;this.emit=emit;this.publish=publish;this.createRuntime=createRuntime;this.normalizeToolPath=normalizeToolPath;
    this.workspaceEpoch=0;this.sessionGeneration=0;this.workspaceSwitchQueue=Promise.resolve();this.operationTail=Promise.resolve();this.operations=new Map();this.preparedUi=new Map();
    this.promptReceipts=new PromptReceipts();this.uiEventPayloads=new UiEventPayloads({onFailure:event=>this.emitAgentEvent(event)});
    this.authLoginSequence=0;this.shuttingDown=false;this.workspaceSwitching=false;this.services=null;this.activeWorkspace=null;
    this.commands=new Map();registerAuthCommands(this.commands);registerModelCommands(this.commands);registerSkillCommands(this.commands);
  }
  get piRuntime(){return this.services?.runtime;}
  get piAdmin(){return this.services?.admin;}
  get skillManager(){return this.services?.skills;}
  status() {
    let session;
    try{session=this.piRuntime?.snapshot().state;}catch{session=this.lastSessionState;}
    const pending=this.piRuntime?.pendingUiRequests() || [];
    const ids=new Set(pending.map(request=>request.id));
    for(const id of this.preparedUi.keys())if(!ids.has(id))this.preparedUi.delete(id);
    return {state:this.startError?'error':this.workspaceSwitching?'starting':this.piRuntime?.state || 'stopped',running:Boolean(this.piRuntime?.running),maintenance:Boolean(this.piAdmin?.maintenanceActive),
      session,sessionGeneration:this.sessionGeneration,workspaceId:this.activeWorkspace?.id,workspaceEpoch:this.workspaceEpoch,
      idleTimeoutMs:this.piRuntime?.idleTimeoutMs,installed:Boolean(this.piRuntime?.findSdkEntry()),pendingUi:[...this.preparedUi.values()],error:this.startError?.message || null};
  }
  queue(operation){const pending=this.operationTail.then(operation,operation);this.operationTail=pending.catch(()=>{});return pending;}
  scope(){return {workspaceId:this.activeWorkspace?.id,workspaceEpoch:this.workspaceEpoch,sessionId:this.piRuntime?.host?.session?.sessionId,sessionGeneration:this.sessionGeneration};}
  assertActiveWorkspace(id){if(id&&id!==this.activeWorkspace?.id)throw fault(409,'工作区已切换');}
  assertScope(scope){if(scope?.workspaceId!==this.activeWorkspace?.id||scope?.workspaceEpoch!==this.workspaceEpoch)throw fault(409,'Agent工作区代次已变化');}
  assertIdle(){
    if(this.piAdmin?.maintenanceActive||this.piRuntime?.isBusy()||this.piRuntime?.pending.size||this.piRuntime?.transitionCount)throw fault(409,'任务完成后再切换工作区');
  }
  async makeServices(workspace,epoch) {
    const layout=await prepareWorkspace(workspace.canonicalRoot);validateWorkspaceSettings(layout.workspaceRoot);
    const runtime=this.createRuntime({cwd:workspace.canonicalRoot,agentDir:this.config.piAgentDir,sessionDir:this.config.piSessionDir,dataPaths:{todoFile:this.config.todoFile,dailyRecordFile:this.config.dailyRecordFile},log:console});
    const admin=new PiAdmin({agentDir:this.config.piAgentDir,cwd:workspace.canonicalRoot,piRuntime:runtime,log:console});
    const service={turnFiles:{involved:new Set(),modified:new Set()},toolCalls:new Map(),turnEpoch:0,runtime,admin,skills:new SkillManager({agentDir:this.config.piAgentDir,cwd:workspace.canonicalRoot,backupDir:this.config.backupDir,piAdmin:admin,log:console}),workspace,epoch};
    runtime.on('sessions-changed',({file})=>{if(this.services===service)this.emit('agent',{type:'sessions_invalidated',file},this.scope());});
    runtime.on('event',event=>{
      if(this.services!==service||service.epoch!==this.workspaceEpoch)return;
      if(event.type==='agent_start')this.clearTurnFiles();
      if(event.type==='agent_settled')for(const [id,call] of service.toolCalls)if(call.success===undefined)service.toolCalls.delete(id);
      if(event.type==='tool_execution_start')void this.trackTool(service,event);
      if(event.type==='tool_execution_end'){const call=service.toolCalls.get(event.toolCallId);if(call){call.success=event.isError===false;this.confirmTool(service,event.toolCallId,call);}}
      if(event.type==='runtime_stopping'||event.type==='runtime_exit'){service.turnEpoch++;service.toolCalls.clear();this.uiEventPayloads.clear();this.preparedUi.clear();}
      if(event.type==='runtime_ready'){if(service.sessionId!==event.state?.sessionId){service.turnFiles.involved.clear();service.turnFiles.modified.clear();}service.sessionId=event.state?.sessionId;this.sessionGeneration++;this.lastSessionState=event.state;this.startError=null;}
      if(event.type==='runtime_exit')this.startError=fault(503,event.error || 'Pi运行时已断开');
      if(this.workspaceSwitching&&event.type!=='extension_ui_request'){this.publish();return;}
      this.emitAgentEvent(event);
    });
    return service;
  }
  emitAgentEvent(event) {
    if(this.workspaceSwitching&&event.type!=='extension_ui_request'){this.publish();return;}
    let prepared=event;
    if(event.type==='extension_ui_request'){
      prepared=Buffer.byteLength(JSON.stringify(event))>MAX_BROWSER_EVENT_BYTES?this.uiEventPayloads.put(event,this.piRuntime,this.workspaceEpoch,this.activeWorkspace.id):event;
      if(event.id)this.preparedUi.set(event.id,prepared);
    }else prepared=boundBrowserAgentEvent(event);
    this.publish();this.emit('agent',prepared,this.scope());
  }
  clearTurnFiles(){const service=this.services;if(!service)return;service.turnEpoch++;service.toolCalls.clear();service.turnFiles.involved.clear();service.turnFiles.modified.clear();}
  turnFileSnapshot(){const files=this.services?.turnFiles;return {involved:[...(files?.involved || [])],modified:[...(files?.modified || [])]};}
  async trackTool(service,event) {
    const name=String(event.toolName || '').toLowerCase(),id=event.toolCallId;
    if(!id||!['read','edit','write'].includes(name))return;
    const raw=event.args?.path ?? event.args?.file_path ?? event.args?.filePath;
    const call={epoch:service.turnEpoch,writes:['edit','write'].includes(name)};service.toolCalls.set(id,call);
    const relative=await this.normalizeToolPath(service.workspace.canonicalRoot,raw).catch(()=>null);
    if(service!==this.services||call.epoch!==service.turnEpoch||service.toolCalls.get(id)!==call)return;
    if(!relative||/^BaodanPark(?:[\\/]|$)/i.test(relative)){service.toolCalls.delete(id);return;}
    call.relative=relative;service.turnFiles.involved.add(relative);this.confirmTool(service,id,call);this.emitAgentEvent({type:'workspace_turn_files',...this.turnFileSnapshot()});
  }
  confirmTool(service,id,call){if(!call.relative||call.success===undefined)return;service.toolCalls.delete(id);if(call.success&&call.writes){service.turnFiles.modified.add(call.relative);this.emitAgentEvent({type:'workspace_turn_files',...this.turnFileSnapshot()});}}
  async ownedSession(file,workspace=this.activeWorkspace) {
    const safe=await assertSessionPath(file,this.config.piSessionDir);
    const metadata=await readSessionMetadata(safe,await stat(safe));
    if(!metadata?.cwd||!sameSessionPath(metadata.cwd,workspace.canonicalRoot))throw fault(403,'该会话不属于当前工作区');
    return {path:safe,...metadata};
  }
  async configure({workspace,epoch,resumePath}) {
    if(this.services){if(workspace.id!==this.activeWorkspace.id||epoch!==this.workspaceEpoch)throw fault(409,'必须通过工作区切换协议改变Agent工作区');return this.status();}
    if(!workspace?.id||!workspace.canonicalRoot||!Number.isSafeInteger(epoch)||epoch<0)throw fault(400,'工作区描述无效');
    this.activeWorkspace=workspace;this.workspaceEpoch=epoch;this.resumePath=resumePath || null;
    try { this.services=await this.makeServices(workspace,epoch); }
    catch(error){this.startError=error;throw error;}
    this.publish();return this.status();
  }
  async ensureStarted() {
    if(this.startError)throw this.startError;
    if(!this.services)throw fault(503,'Agent尚未配置');
    try {
      if(!this.piRuntime.running&&!this.piRuntime.activeSessionPath&&this.resumePath)await this.ownedSession(this.resumePath);
      await this.piRuntime.ensureStarted(this.piRuntime.activeSessionPath || this.resumePath);
    }catch(error){this.startError=error;this.publish();throw error;}
  }
  operation(id){const op=this.operations.get(id);return op?{status:op.status,result:op.result,error:op.error,epoch:op.epoch}:{status:'unknown'};}
  async prepareSwitch(args) {
    const {operationId,workspace,epoch,resumePath}=args;
    if(!operationId||!workspace?.id||!Number.isSafeInteger(epoch))throw fault(409,'切换操作或代次无效');
    if(this.operations.has(operationId)){const old=this.operations.get(operationId);if(old.targetId!==workspace.id||old.requestEpoch!==epoch)throw fault(409,'切换操作ID已被使用');return this.operation(operationId);}
    if(epoch<=this.workspaceEpoch)throw fault(409,'切换代次已过期');
    const op={status:'pending',epoch,requestEpoch:epoch,targetId:workspace.id,taken:false,before:{workspace:this.activeWorkspace,services:this.services,path:this.piRuntime?.activeSessionPath,manager:this.piRuntime?.host?.session?.sessionManager}};
    this.operations.set(operationId,op);
    while(this.operations.size>128){const first=this.operations.keys().next().value;if(['pending','prepared'].includes(this.operations.get(first).status))break;this.operations.delete(first);}
    try {
      this.assertIdle();op.taken=true;this.workspaceSwitching=true;this.workspaceEpoch=epoch;this.uiEventPayloads.clear();this.preparedUi.clear();
      await this.piAdmin.close();await this.piRuntime.close();
      this.activeWorkspace=workspace;this.lastSessionState=null;this.startError=null;
      this.services=await this.makeServices(workspace,epoch);
      if(this.shuttingDown)throw fault(503,'Agent正在退出');
      if(resumePath)await this.ownedSession(resumePath);
      await this.piRuntime.ensureStarted(resumePath || null);
      op.result={state:await this.piRuntime.send({type:'get_state'})};op.status='prepared';this.publish();return this.operation(operationId);
    }catch(error){op.status='failed';op.error={code:error.statusCode||500,message:publicErrorMessage(error)};this.publish();throw error;}
  }
  async commitSwitch({operationId,epoch}) {
    const op=this.operations.get(operationId);
    if(!op||op.epoch!==epoch||!['prepared','committed'].includes(op.status))throw fault(409,'切换操作尚未就绪');
    if(op.status==='committed')return this.operation(operationId);
    op.status='committed';op.before=null;this.workspaceSwitching=false;this.startError=null;
    this.emitAgentEvent({type:'runtime_ready',state:op.result.state});return this.operation(operationId);
  }
  async rollbackSwitch({operationId,epoch}) {
    const op=this.operations.get(operationId);
    if(op?.status==='rolledBack')return this.operation(operationId);
    if(!op?.before||!Number.isSafeInteger(epoch)||epoch<=this.workspaceEpoch||op.status==='committed')throw fault(409,'不能回滚该操作');
    const previous=op.before;this.workspaceEpoch=epoch;this.uiEventPayloads.clear();this.preparedUi.clear();
    if(op.taken){
      await this.piAdmin?.close();await this.piRuntime?.close();
      if(this.piRuntime?.running)throw fault(503,'目标运行时未释放，请重试助手进程');
      this.activeWorkspace=previous.workspace;this.services=await this.makeServices(previous.workspace,epoch);
      if(previous.path&&!existsSync(previous.path)&&previous.manager){this.piRuntime.activeSessionPath=previous.path;this.piRuntime.unsavedManager=previous.manager;}
      this.startError=null;await this.piRuntime.ensureStarted(previous.path || null);
      this.services.turnFiles=previous.services.turnFiles;
    }else{this.activeWorkspace=previous.workspace;this.services.epoch=epoch;}
    this.workspaceSwitching=false;op.status='rolledBack';op.epoch=epoch;op.before=null;
    op.result={state:this.piRuntime.snapshot().state};this.emitAgentEvent({type:'runtime_ready',state:op.result.state});
    for(const request of this.piRuntime.pendingUiRequests())this.emitAgentEvent(request);
    return this.operation(operationId);
  }
  startAuthLogin(providerId,subscriptionId) {
    const abort=new AbortController(),sequence=++this.authLoginSequence;
    this.activeAuthLoginAbort?.abort();this.activeAuthLoginAbort=abort;this.authSubscriptionId=subscriptionId;
    const emit=event=>{this.publish();this.emit('auth',{subscriptionId,...event},this.scope());};
    void (async()=>{try{await this.piAdmin.cancelOAuthLogins();if(!abort.signal.aborted&&sequence===this.authLoginSequence)await this.piAdmin.loginOAuth(providerId,{signal:abort.signal,emit});}
      catch(error){emit({type:abort.signal.aborted?'cancelled':'error',message:publicErrorMessage(error)});}
      finally{if(this.activeAuthLoginAbort===abort)this.activeAuthLoginAbort=null;this.publish();}})();return {ok:true};
  }
  async invoke(name,args,scope,signal) {
    if(name==='control.operation')return this.operation(args.operationId);
    if(name==='control.quiesce'){this.beginShutdown();return {ok:true};}
    const interactive=name==='agent.uiPayload'||name==='auth.input'||name==='auth.cancel'||(name==='agent.command'&&['extension_ui_response','abort','abort_retry','abort_bash'].includes(args.type));
    const run=async()=>{
      if(this.shuttingDown)throw fault(503,'Agent正在退出');
      if(name==='control.configure')return this.configure(args);
      if(name==='control.prepareWorkspace')return this.prepareSwitch(args);
      if(name==='control.commitWorkspace')return this.commitSwitch(args);
      if(name==='control.rollbackWorkspace')return this.rollbackSwitch(args);
      this.assertScope(scope);
      if(this.workspaceSwitching&&!interactive)throw fault(409,'工作区正在切换');
      if(signal?.aborted)throw fault(499,'操作已取消');
      if(this.piAdmin?.maintenanceActive&&['agent.start','agent.bootstrap','agent.new','agent.snapshot','sessions.activate','sessions.rename','sessions.delete','projectPrompt.save'].includes(name))throw fault(409,'登录或配置维护中，请稍后重试');
      if(name==='agent.uiPayload')return this.uiEventPayloads.get(args.token,this.piRuntime,this.workspaceEpoch,this.activeWorkspace.id);
      if(name==='auth.start')return this.startAuthLogin(args.providerId,args.subscriptionId);
      if(name==='auth.cancel'){if(args.subscriptionId===this.authSubscriptionId)this.activeAuthLoginAbort?.abort();return {ok:true};}
      if(name==='agent.receipt')return this.promptReceipts.get(args.requestId);
      if(name==='agent.start'){await this.ensureStarted();return {ok:true,url:'/assistant.html'};}
      if(name==='agent.bootstrap'){
        await this.ensureStarted();const [state,messages,models,thinking,preferences]=await Promise.all([this.piRuntime.send({type:'get_state'}),this.piRuntime.send({type:'get_messages'}),this.piRuntime.send({type:'get_available_models'}),this.piRuntime.send({type:'get_available_thinking_levels'}),this.piAdmin.preferences()]);
        return {state,messages:messages.messages,models:models.models,thinkingLevels:thinking.levels,...preferences,turnFiles:this.turnFileSnapshot()};
      }
      if(name==='agent.snapshot'){if(!this.piRuntime.running)await this.ensureStarted();return {...this.piRuntime.snapshot({messages:args.messages==='1',since:args.since}),turnFiles:this.turnFileSnapshot()};}
      if(name==='agent.new'){if(this.piAdmin.maintenanceActive)throw fault(409,'配置维护中');const state=await this.piRuntime.newSession();return {ok:true,state};}
      if(name==='agent.command'){
        const body={...assertAllowedAgentCommand(args)};
        if(body.type==='extension_ui_response'){
          if(!this.piRuntime.pendingUiRequests().some(request=>request.id===body.id))throw fault(410,'交互已过期');
        }else{
          if(this.piAdmin.maintenanceActive)throw fault(409,'配置维护中，请等待');
          if(scope.sessionGeneration!=null&&scope.sessionGeneration!==this.sessionGeneration&&!body.type.startsWith('get_'))throw fault(409,'会话代次已变化');
          this.assertActiveWorkspace(body.workspaceId);await this.ensureStarted();
        }
        if(body.type==='prompt')validatePromptPayload(body);
        else if(Buffer.byteLength(JSON.stringify(body))>(body.type==='extension_ui_response'?MAX_UI_RESPONSE_BYTES:1024*1024))throw fault(413,'请求内容过大');
        const receipt={...body};delete body.workspaceId;
        const data=body.type==='prompt'&&body.requestId?await this.promptReceipts.submit(body.requestId,receipt,()=>this.piRuntime.send(body)):await this.piRuntime.send(body);
        return {ok:true,data:body.type==='get_messages'?{...data,turnFiles:this.turnFileSnapshot()}:data};
      }
      if(name.startsWith('sessions.')){
        await this.ownedSession(args.path);
        if(this.piAdmin.maintenanceActive)throw fault(409,'配置维护中');
        if(name==='sessions.activate')return {ok:true,state:await this.piRuntime.openSession(args.path)};
        if(name==='sessions.rename')return {ok:true,...await this.piRuntime.renameSession(args.path,args.name)};
        if(name==='sessions.delete')return {ok:true,...await this.piRuntime.deleteSession(args.path)};
      }
      if(name==='projectPrompt.save'){
        this.assertActiveWorkspace(args.workspaceId);
        if(this.piAdmin.maintenanceActive)throw fault(409,'配置维护中');
        return this.piRuntime.updateProjectPrompt(async()=>({...await saveProjectPrompt(this.activeWorkspace.canonicalRoot,args,this.config.backupDir),workspaceId:this.activeWorkspace.id}));
      }
      const command=this.commands.get(name);if(!command)throw fault(403,'未授权Agent操作');
      return command(args,this,signal);
    };
    try{return await (interactive?run():this.queue(run));}finally{this.publish();}
  }
  beginShutdown() {
    if(this.quiescing)return this.quiescing;this.shuttingDown=true;this.activeAuthLoginAbort?.abort();this.uiEventPayloads.clear();this.preparedUi.clear();
    this.quiescing=Promise.allSettled([this.piAdmin?.close(),this.piRuntime?.beginShutdown()]);return this.quiescing;
  }
  async shutdown(pending=[]) {
    for(const item of pending)item?.controller?.abort();
    await this.beginShutdown();await Promise.allSettled(pending.map(item=>item?.task || item));await this.operationTail;await this.workspaceSwitchQueue;await this.piAdmin?.maintenanceTail;await this.piRuntime?.close();
  }
}
