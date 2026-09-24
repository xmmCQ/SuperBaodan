import { readFile, stat } from 'node:fs/promises';
import { fault } from '../shared/errors.js';

// A single-file read cache, not a writer: mutations still perform their own
// fresh reads, revision checks, validation, backup and atomic replacement.
export function createVersionedReader(file, decode) {
  let cached, pending, generation = 0;
  const version = info => [info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');
  function invalidate() { generation++; cached = null; pending = null; }
  function read() {
    if (pending) return pending;
    const epoch = generation;
    const operation = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await stat(file,{bigint:true}), key = version(before);
        if (epoch !== generation) return read();
        if (cached?.key === key) return cached;
        const content = await readFile(file,'utf8');
        // Keep the existing normal-Stats revision representation. BigIntStats
        // truncates milliseconds on Windows whereas Stats dates round them.
        const standardStat = await stat(file), after = await stat(file,{bigint:true});
        if (epoch !== generation) return read();
        if (key !== version(after)) continue;
        const result = {key,value:decode(content),stat:standardStat};
        if (epoch !== generation) return read();
        cached = result; return result;
      }
      throw fault(409,'文件在读取期间发生变化，请重试');
    };
    const promise = operation().finally(() => { if (pending === promise) pending = null; });
    pending = promise; return promise;
  }
  return { read, invalidate };
}
