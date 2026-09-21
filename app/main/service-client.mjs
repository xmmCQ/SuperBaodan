import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { COMMANDS, MAX_PENDING_REQUESTS, MAX_MESSAGE_BYTES } from '../shared/commands.js';
import { fault } from '../shared/errors.js';

export class ServiceClient extends EventEmitter {
  constructor(backend) {
    super(); this.backend = backend; this.pending = new Map();
    backend.on('message', ({ run, message }) => {
      if (run !== backend.currentRun) return;
      if (message.type === 'event') { this.emit('event', message); return; }
      const item = this.pending.get(message.id);
      if (message.type !== 'result' || !item || item.run !== run) return;
      if (message.error) item.reject(fault(message.error.code, message.error.message));
      else item.resolve(message.value);
    });
    backend.on('exit', () => { for (const item of this.pending.values()) item.reject(fault(503, '应用服务已断开')); });
  }

  invoke(name, args = {}, { signal, timeout = 120000 } = {}) {
    if (!COMMANDS.includes(name)) return Promise.reject(fault(403, '未授权的应用操作'));
    const run = this.backend.currentRun;
    if (this.backend.state !== 'running' || !run?.child?.connected) return Promise.reject(fault(503, '应用服务尚未就绪'));
    if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(fault(429, '操作繁忙，请稍后重试'));
    if (!args || typeof args !== 'object' || Array.isArray(args)) return Promise.reject(fault(400, '参数必须是对象'));
    // Binary uploads are bounded separately; all other messages retain a size ceiling.
    if (args.content?.byteLength > MAX_MESSAGE_BYTES || Buffer.byteLength(JSON.stringify({ ...args, content: undefined })) > MAX_MESSAGE_BYTES) return Promise.reject(fault(413, '操作内容过大'));
    if (signal?.aborted) return Promise.reject(fault(499, '操作已取消'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (fn, value) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value);
      };
      const cancel = () => { if (run.child.connected) run.child.send({ type: 'cancel', id, runId: run.id }, () => {}); };
      const abort = () => { cancel(); finish(reject, fault(499, '操作已取消')); };
      this.pending.set(id, { run, resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { cancel(); finish(reject, fault(408, '操作超时')); }, timeout);
      try { run.child.send({ type: 'invoke', runId: run.id, id, name, args }, error => { if (error) finish(reject, error); }); }
      catch (error) { finish(reject, error); }
    });
  }
}
