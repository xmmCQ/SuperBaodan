import { ServiceClient } from './service-client.mjs';
import { AGENT_INTERNAL_COMMANDS, PROCESS_PROTOCOL, checkAgentRequest, isControlRequest, hasRequestCapacity } from '../shared/agent-protocol.js';
import { publicErrorMessage, fault } from '../shared/errors.js';

// Transport only. Workspace/session decisions remain in the two business processes.
export class ServiceBroker {
  constructor(local, agent) {
    this.local=local;this.agent=agent;this.pending=new Map();this.starting=null;this.closing=false;
    this.snapshot={processState:'idle',state:'stopped',installed:null};
    this.rpc=new ServiceClient(agent,{commands:AGENT_INTERNAL_COMMANDS,disconnected:'助手进程已断开，操作结果未知；请重新读取确认，勿重复提交'});
    local.on('message',({run,message})=>this.receive(run,message));
    local.on('exit',()=>{for(const request of this.pending.values())request.abort();this.pending.clear();if(!this.closing){this.requireRetry=true;this.invalidatedRun=agent.currentRun?.id;this.snapshot={...this.snapshot,processState:'failed',state:'error',error:'业务连接已变化，请重试助手'};void agent.stop(10000).then(ok=>ok||agent.forceStop()).catch(()=>{});}});
    agent.on('message',({run,message})=>{
      if(run!==agent.currentRun||run.id===this.invalidatedRun)return;
      if(message.type==='agent-status'){this.snapshot={...message.value,processState:'connected',agentRunId:run.id};this.publish();}
      if(message.type==='event')this.sendLocal({type:'agent-event',agentRunId:run.id,name:message.name,scope:message.scope,topic:message.topic,event:message.event});
    });
    agent.on('exit',({runId,expected})=>{
      if(!expected)this.requireRetry=true;
      const failed=!expected||this.requireRetry;
      this.snapshot={processState:failed?'failed':'idle',state:failed?'error':'stopped',installed:this.snapshot.installed,agentRunId:runId,error:failed?'助手进程已断开，请点击重试；在途操作结果可能未知':''};
      this.publish();
    });
  }
  sendLocal(message, run=this.local.currentRun) {
    if(run && run===this.local.currentRun && !run.exitInfo && run.child?.connected)run.child.send({v:PROCESS_PROTOCOL,runId:run.id,...message},()=>{});
  }
  publish(){this.sendLocal({type:'agent-status',name:'agent.status',agentRunId:this.snapshot.agentRunId,value:this.snapshot});}
  start(retry=false) {
    if(this.closing)return Promise.reject(fault(503,'工作台正在退出'));
    if(this.starting)return this.starting;
    const failed=this.requireRetry||this.snapshot.processState==='failed'||this.snapshot.state==='error'||this.agent.state==='failed';
    if(failed&&!retry)return Promise.reject(fault(503,'助手不可用，请点击重试；不会自动重启或重发操作'));
    const operation=(async()=>{
      if(failed&&retry){if(!await this.agent.stop(10000)&&!await this.agent.forceStop())throw fault(503,'原助手进程尚未完全退出');}
      this.requireRetry=false;this.snapshot={...this.snapshot,processState:'starting',state:'starting'};this.publish();
      const ready=await this.agent.start();
      return {agentRunId:ready.desktopInstanceId,state:this.snapshot};
    })().catch(error=>{this.requireRetry=true;this.snapshot={...this.snapshot,processState:'failed',state:'error',error:publicErrorMessage(error)};this.publish();throw error;});
    this.starting=operation;operation.finally(()=>{if(this.starting===operation)this.starting=null;}).catch(()=>{});return operation;
  }
  receive(run,message) {
    if(run!==this.local.currentRun||message.v!==PROCESS_PROTOCOL)return;
    if(message.type==='agent-cancel'){this.pending.get(message.id)?.abort();return;}
    if(message.type==='agent-state-request'){this.publish();return;}
    if(message.type==='agent-invalidate'&&message.agentRunId===this.agent.currentRun?.id){
      this.requireRetry=true;this.invalidatedRun=message.agentRunId;this.snapshot={...this.snapshot,processState:'failed',state:'error',error:String(message.message || '助手状态无法确认，请重试')};this.publish();return;
    }
    if(!['agent-start','agent-invoke'].includes(message.type)||typeof message.id!=='string')return;
    if(message.type==='agent-invoke'&&!checkAgentRequest(message))return this.sendLocal({type:'agent-result',id:message.id,name:message.name,error:{code:403,message:'未授权的Agent命令'}},run);
    if(this.closing||this.pending.has(message.id)||!hasRequestCapacity(this.pending,message.name,message.args))return this.sendLocal({type:'agent-result',id:message.id,name:message.name,error:{code:429,message:'Agent请求繁忙，请稍后重试'}},run);
    const controller=Object.assign(new AbortController(),{name:message.name,args:message.args});this.pending.set(message.id,controller);
    const operation=message.type==='agent-start'?this.start(message.retry===true):Promise.resolve().then(()=>{
      if(message.agentRunId!==this.agent.currentRun?.id||this.agent.state!=='running'||this.invalidatedRun===message.agentRunId)throw fault(503,'助手运行代次已变化，操作结果未知；请重新读取确认');
      return this.rpc.invoke(message.name,message.args,{signal:controller.signal,scope:message.scope,timeout:isControlRequest(message.name,message.args)?15000:120000});
    });
    void operation.then(value=>this.sendLocal({type:'agent-result',id:message.id,name:message.name,agentRunId:this.agent.currentRun?.id,scope:message.scope,value},run),error=>this.sendLocal({type:'agent-result',id:message.id,name:message.name,agentRunId:message.agentRunId,scope:message.scope,error:{code:error.statusCode||503,message:publicErrorMessage(error)}},run)).finally(()=>this.pending.delete(message.id));
  }
  async stop(timeout=10000) {
    this.closing=true;
    // End the waits first; each process independently drains accepted writes.
    for(const request of this.pending.values())request.abort();
    const results=await Promise.allSettled([this.local.stop(timeout),this.agent.stop(timeout)]);
    return results.every(result=>result.status==='fulfilled'&&result.value);
  }
  async forceStop() {
    const results=await Promise.allSettled([this.local.currentRun?this.local.forceStop():true,this.agent.currentRun?this.agent.forceStop():true]);
    return results.every(result=>result.status==='fulfilled'&&result.value);
  }
}
