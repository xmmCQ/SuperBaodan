import { mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-file.mjs';

export async function initializeJsonFile(owner, initial) {
  await Promise.all([mkdir(path.dirname(owner.filePath),{recursive:true}),mkdir(owner.backupDir,{recursive:true})]);
  if (!existsSync(owner.filePath)) await writeJsonAtomic(owner.filePath,initial(),{randomUUID:owner.randomUUID});
}
export async function backupJsonFile(owner, prefix) {
  if (!existsSync(owner.filePath)) return;
  const stamp = owner.now().toISOString().replace(/[:.]/g,'-');
  await copyFile(owner.filePath,path.join(owner.backupDir,`${prefix}-${stamp}-${owner.randomUUID().slice(0,8)}.json`));
}
// Only shared I/O choreography; each manager retains its validation and results.
export async function queueJsonMutation(owner, operation) {
  await owner.initialize();
  const run = async () => {
    owner.reader?.invalidate();
    const store = await owner.readStore();
    const outcome = await operation(store);
    if (outcome.changed) {
      owner.reader?.invalidate();
      try {
        await owner.backup();
        await writeJsonAtomic(owner.filePath,store,{randomUUID:owner.randomUUID});
        await owner.trimBackups?.();
      } finally { owner.reader?.invalidate(); }
    }
    return outcome;
  };
  const pending = owner.mutationTail.then(run,run);
  owner.mutationTail = pending.catch(()=>{});
  return pending;
}
