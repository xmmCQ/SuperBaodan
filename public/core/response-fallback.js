// One request chain at a time, including across stop/start. Aborting HTTP here
// only stops observation; it never sends an Agent abort command.
export function createResponseFallback({ readSnapshot, applySnapshot, lastEventAt, interval = 1500, quietMs = 1800 }) {
  let enabled = false, flight = null, timer = null, controller = null, generation = 0, version;
  function schedule() {
    clearTimeout(timer);
    if (enabled) timer = setTimeout(tick, interval);
  }
  async function tick() {
    timer = null;
    if (!enabled || flight) return;
    if (Date.now() - lastEventAt() < quietMs) { schedule(); return; }
    const epoch = generation;
    controller = new AbortController();
    const signal = controller.signal;
    flight = (async () => {
      const status = await readSnapshot({ signal });
      if (!enabled || epoch !== generation) return;
      let snapshot = status;
      if (version !== status.messagesVersion) snapshot = await readSnapshot({ signal, messages: true, since: version });
      if (!enabled || epoch !== generation) return;
      await applySnapshot(snapshot);
      version = snapshot.messagesVersion;
      if (!snapshot.state?.isStreaming && !snapshot.state?.isCompacting) enabled = false;
    })();
    try { await flight; } catch { /* Retry observations, never resend prompts. */ }
    finally { flight = null; controller = null; schedule(); }
  }
  return {
    start() { enabled = true; generation += 1; version = undefined; controller?.abort(); if (!flight) schedule(); },
    stop() { enabled = false; generation += 1; clearTimeout(timer); timer = null; controller?.abort(); },
  };
}
