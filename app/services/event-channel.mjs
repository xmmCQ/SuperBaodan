// Keep high-frequency model events from growing the parent IPC queue without bound.
export function createEventChannel(send, { maxQueued = 128 } = {}) {
  const queue = [];
  let sending = false, closed = false;
  function drain() {
    if (closed || sending || !queue.length) return;
    sending = true;
    const value = queue.shift();
    try { send(value, () => { sending = false; drain(); }); }
    catch { sending = false; queue.length = 0; }
  }
  return {
    push(topic, event, metadata = {}) {
      if (closed) return;
      if (queue.length >= maxQueued) {
        queue.length = 0;
        queue.push({ ...metadata, type: 'event', topic: 'agent', event: { type: 'extension_error', error: '事件积压，请同步对话', snapshotRequired: true } });
      }
      queue.push({ ...metadata, type: 'event', topic, event }); drain();
    },
    close() { closed = true; queue.length = 0; },
    queued: () => queue.length,
  };
}
