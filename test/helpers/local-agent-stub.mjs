import { EventEmitter } from 'node:events';
import { fault } from '../../app/shared/errors.js';

// Serializable command boundary for local coordination tests. No SDK/host proxy.
export class LocalAgentStub extends EventEmitter {
  constructor(calls=[]) {super();this.calls=calls;this.hooks=new Map();this.operations=new Map();this.snapshot={processState:'connected',agentRunId:'fixture-run',state:'running',maintenance:false,session:{sessionId:'fresh-A'}};}
  async ensureConnected() {}
  async configure({workspace,epoch}) {this.workspace ||= workspace;this.epoch ??= epoch;}
  adoptScope(workspace,epoch){this.workspace=workspace;this.epoch=epoch;this.snapshot.session={sessionId:`fresh-${workspace.name==='B'?'B':'A'}`};}
  receiptKnown(){return false;} close(){} markUnavailable(message){this.snapshot.processState='failed';this.snapshot.error=message;}
  async invoke(name,args={},options={}) {
    if(options.signal?.aborted)throw fault(499,'cancelled');
    if(this.snapshot.maintenance&&!['agent.uiPayload','agent.command','control.operation'].includes(name))throw fault(409,'maintenance');
    const hook=this.hooks.get(name);if(hook)return hook(args,options);
    if(name==='control.prepareWorkspace') {this.operations.set(args.operationId,{status:'prepared',epoch:args.epoch,result:{state:{sessionId:`fresh-${args.workspace.name==='B'?'B':'A'}`}}});return this.operations.get(args.operationId);}
    if(name==='control.commitWorkspace'){const op=this.operations.get(args.operationId);op.status='committed';return op;}
    if(name==='control.rollbackWorkspace'){return {status:'rolledBack',result:{state:this.snapshot.session}};}
    if(name==='control.operation')return this.operations.get(args.operationId) || {status:'unknown'};
    const label=this.workspace?.name==='B'?'B':'A';
    if(name==='agent.bootstrap')return {state:{sessionId:`fresh-${label}`},messages:[{owner:label}],models:[],thinkingLevels:['off']};
    if(name==='agent.new'){this.calls.push(`${label}:new`);return {ok:true,state:{sessionId:`new-${label}`}};}
    if(name==='agent.start')return {ok:true};
    if(name==='agent.snapshot')return {state:{sessionId:`fresh-${label}`},owner:label};
    if(name==='sessions.activate'){this.calls.push(`${label}:open:${args.path}`);return {ok:true,state:{sessionId:'session-A'}};}
    if(name==='sessions.rename'){this.calls.push(`${label}:rename:${args.path}`);return {ok:true,renamed:true};}
    if(name==='sessions.delete'){this.calls.push(`${label}:delete:${args.path}`);return {ok:true,deleted:true};}
    return {ok:true,data:{}};
  }
}
