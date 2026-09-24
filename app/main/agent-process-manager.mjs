import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BackendManager } from './backend-manager.mjs';

export class AgentProcessManager extends BackendManager {
  constructor(config, dependencies = {}) {
    super({...config,processRole:'agent',entryFile:config.agentEntry || path.join(config.root,'app','agent','main.mjs')},dependencies);
  }
  async initialize() {
    await Promise.all([mkdir(this.logDir,{recursive:true}),mkdir(this.config.piAgentDir,{recursive:true})]);
  }
}
