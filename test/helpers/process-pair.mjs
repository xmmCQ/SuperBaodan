import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendManager } from '../../app/main/backend-manager.mjs';
import { AgentProcessManager } from '../../app/main/agent-process-manager.mjs';
import { ServiceBroker } from '../../app/main/service-broker.mjs';
import { ServiceClient } from '../../app/main/service-client.mjs';
import { createTempProject } from './temp-project.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export async function processPair(t,{native=false,agentEntry=path.join(root,'test/helpers/fake-agent-process.mjs'),piPackagePath}={}) {
  const temp=await createTempProject('sb-agent-pair-');
  const config={root,dataRoot:temp.root,nodePath:process.execPath,piAgentDir:temp.resolve('agent'),piPackagePath,packaged:false,supervise:native,agentEntry};
  const local=new BackendManager(config),agent=new AgentProcessManager(config),broker=new ServiceBroker(local,agent),service=new ServiceClient(local);
  t.after(async()=>{if(!await broker.stop(8000))await broker.forceStop();await temp.cleanup();});
  await local.start();return {temp,config,local,agent,broker,service};
}
export const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until(predicate,ms=5000){const deadline=Date.now()+ms;while(!predicate()){if(Date.now()>deadline)throw Error('等待进程状态超时');await wait(20);}}
