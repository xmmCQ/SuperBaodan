import { fault } from '../../shared/errors.js';
import { searchSessionText } from '../domain/session-text-search.mjs';

// Metadata and text scanning do not load the SDK or wait for Agent readiness.
export function registerSessionCommands(commands) {
  commands.set('sessions.search',async(args,context,signal)=>{
    context.assertActiveWorkspace(args.workspaceId);
    if((context.activeSessionSearches || 0)>=2)throw fault(429,'搜索繁忙，请稍后重试');
    const workspace=context.activeWorkspace,epoch=context.workspaceEpoch;
    context.activeSessionSearches=(context.activeSessionSearches || 0)+1;
    try {
      const result=await searchSessionText({sessionDir:context.config.piSessionDir,workspaceRoot:workspace.canonicalRoot,query:args.q,signal});
      context.assertActiveWorkspace(workspace.id);if(epoch!==context.workspaceEpoch)throw fault(409,'工作区已变化');
      return {...result,workspaceId:workspace.id};
    }finally{context.activeSessionSearches--;}
  });
  commands.set('sessions.list',async(args,context)=>{context.assertActiveWorkspace(args.workspaceId);return {sessions:await context.listActiveSessions()};});
}
