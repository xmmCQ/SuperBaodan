export function createBoundedSse(res, { maxBufferBytes = 256 * 1024, stallMs = 15000 } = {}) {
  let blocked = false, closed = false, queuedBytes = 0, stallTimer;
  const queue = [];
  function cleanup() {
    if (closed) return;
    closed = true; queue.length = 0; queuedBytes = 0;
    clearTimeout(stallTimer); res.removeListener("drain", drain); res.removeListener("close", cleanup);
  }
  function close() { cleanup(); if (!res.destroyed) res.destroy(); }
  function writeChunk(chunk) {
    try {
      if (!res.write(chunk)) {
        blocked = true;
        stallTimer = setTimeout(close, stallMs); stallTimer.unref?.();
      }
      if ((res.writableLength || 0) > maxBufferBytes) close();
    } catch { close(); }
  }
  function drain() {
    clearTimeout(stallTimer); blocked = false;
    while (!closed && !blocked && queue.length) {
      const chunk = queue.shift(); queuedBytes -= Buffer.byteLength(chunk); writeChunk(chunk);
    }
  }
  res.on("drain", drain); res.once("close", cleanup);
  return {
    write(chunk) {
      if (closed || res.destroyed || res.writableEnded) return false;
      const bytes = Buffer.byteLength(chunk);
      if (bytes + queuedBytes + (res.writableLength || 0) > maxBufferBytes) { close(); return false; }
      if (blocked) { queue.push(chunk); queuedBytes += bytes; }
      else writeChunk(chunk);
      return !closed;
    },
    close,
  };
}
