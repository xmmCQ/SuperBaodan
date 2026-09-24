import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PROCESS_PROTOCOL, AGENT_INTERNAL_COMMANDS, isControlRequest } from '../shared/agent-protocol.js';
import { fault } from '../shared/errors.js';

export class AgentClient extends EventEmitter {
  constructor({send,runId}) {
    super();this.send=send;this.runId=runId;this.pending=new Map();this.snapshot={processState:'idle',state:'stopped',installed:null};this.configuration=null;this.starting=null;this.preparing=null;this.closed=false;this.promptRuns=new Map();
  }
  receive(message) {
    if(message.v!==PROCESS_PROTOCOL||message.runId!==this.runId)return;
    if(message.type==='agent-status'){
      const previous=this.snapshot;this.snapshot=message.value;
      if(previous.agentRunId!==this.snapshot.agentRunId||['failed','idle'].includes(this.snapshot.processState)){
        this.configuration=null;this.preparing=null;
        for(const item of [...this.pending.values()])if(item.agentRunId&&(item.agentRunId!==this.snapshot.agentRunId||this.snapshot.processState!=='connected'))item.reject(fault(503,'助手已断开，操作结果未知；请读取确认，勿重复提交'));
      }
      this.emit('status',this.snapshot,previous);return;
    }
    if(message.type==='agent-event'){
      if(message.agentRunId===this.snapshot.agentRunId&&this.snapshot.processState!=='failed')this.emit('event',message);return;
    }
    const item=this.pending.get(message.id);
    if(message.type!=='agent-result'||!item||message.name!==item.name)return;
    if(item.agentRunId&&message.agentRunId!==item.agentRunId)return item.reject(fault(503,'助手运行代次已变化，结果未知'));
    if(message.error)item.reject(fault(message.error.code,message.error.message));else item.resolve(message.value);
  }
  request(type,name,args={}, {scope,signal,retry=false,timeout=120000}={}) {
    if(this.closed)return Promise.reject(fault(503,'工作台正在退出'));
    if(type==='agent-invoke'&&!AGENT_INTERNAL_COMMANDS.includes(name))return Promise.reject(fault(403,'未授权Agent命令'));
    if(signal?.aborted)return Promise.reject(fault(499,'操作已取消'));
    const id=randomUUID(),agentRunId=type==='agent-start'?null:this.snapshot.agentRunId;
    return new Promise((resolve,reject)=>{
      let timer;
      const finish=(fn,value)=>{if(!this.pending.delete(id))return;clearTimeout(timer);signal?.removeEventListener('abort',abort);fn(value);};
      const cancel=()=>this.send({v:PROCESS_PROTOCOL,type:'agent-cancel',runId:this.runId,id,name,agentRunId});
      const abort=()=>{cancel();finish(reject,fault(499,'已取消等待；已受理的写入可能完成，请读取确认'));};
      this.pending.set(id,{name,agentRunId,resolve:value=>finish(resolve,value),reject:error=>finish(reject,error)});
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>{cancel();finish(reject,fault(408,'助手操作超时，结果未知；请读取确认，勿重复提交'));},timeout);
      this.send({v:PROCESS_PROTOCOL,type,runId:this.runId,id,name,args,scope,agentRunId,retry},error=>{if(error)finish(reject,fault(503,'助手连接已断开，结果未知'));});
    });
  }
  async ensureConnected(retry=false) {
    if(this.starting)return this.starting;
    if(!retry&&this.snapshot.processState==='connected')return;
    if(!retry&&this.snapshot.processState==='failed')throw fault(503,'助手已断开，请点击重试');
    const operation=this.request('agent-start','agent.start',{}, {retry,timeout:45000}).then(result=>{
      if(this.snapshot.agentRunId!==result.agentRunId)this.configuration=null;
      const state=this.snapshot.agentRunId===result.agentRunId?this.snapshot:result.state;
      this.snapshot={...state,agentRunId:result.agentRunId,processState:'connected'};
    });
    this.starting=operation;operation.finally(()=>{if(this.starting===operation)this.starting=null;}).catch(()=>{});return operation;
  }
  async configure(descriptor,{retry=false,signal}={}) {
    await this.ensureConnected(retry);
    if(signal?.aborted)throw fault(499,'操作已取消');
    const key=`${this.snapshot.agentRunId}:${descriptor.workspace.id}:${descriptor.epoch}`;
    if(this.configuration===key)return;
    if(this.preparing?.key===key)return this.preparing.promise;
    const promise=this.invoke('control.configure',descriptor,{scope:{workspaceId:descriptor.workspace.id,workspaceEpoch:descriptor.epoch}}).then(()=>{this.configuration=key;});
    this.preparing={key,promise};promise.finally(()=>{if(this.preparing?.promise===promise)this.preparing=null;}).catch(()=>{});return promise;
  }
  invoke(name,args={},options={}) {
    const scope={...options.scope};
    if(!isControlRequest(name,args)){
      scope.sessionGeneration=this.snapshot.sessionGeneration;
      scope.sessionId=this.snapshot.session?.sessionId || null;
    }
    if(name==='agent.command'&&args.type==='prompt'&&args.requestId){
      this.promptRuns.set(args.requestId,this.snapshot.agentRunId);
      while(this.promptRuns.size>2048)this.promptRuns.delete(this.promptRuns.keys().next().value);
    }
    return this.request('agent-invoke',name,args,{...options,scope});
  }
  adoptScope(workspace,epoch) { this.configuration=`${this.snapshot.agentRunId}:${workspace.id}:${epoch}`; }
  receiptKnown(requestId) { return this.snapshot.processState==='connected'&&this.promptRuns.get(requestId)===this.snapshot.agentRunId; }
  markUnavailable(message) { this.snapshot={...this.snapshot,processState:'failed',state:'error',error:message};this.configuration=null;this.send({v:PROCESS_PROTOCOL,type:'agent-invalidate',runId:this.runId,name:'agent.status',agentRunId:this.snapshot.agentRunId,message});this.emit('status',this.snapshot); }
  close() { this.closed=true;for(const [id,item] of [...this.pending]){this.send({v:PROCESS_PROTOCOL,type:'agent-cancel',runId:this.runId,id,name:item.name});item.reject(fault(503,'工作台正在退出；Agent操作结果可能未知'));} }
}
