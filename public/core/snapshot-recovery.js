// SDK history excludes the unfinished streaming message. Wait for its end,
// then coalesce omitted bodies into one quiet read; silence alone is not enough.
export function createSnapshotRecovery({ sync, quietMs = 150, captureContext = () => () => true }) {
  let dirty = false, messageOpen = false, timer = null, flight = null, lastEventAt = 0, current = captureContext();
  function recovered() { dirty = false; clearTimeout(timer); timer = null; }
  function reset() { recovered(); messageOpen = false; current = captureContext(); }
  function checkContext() { if (!current()) reset(); }
  // Shared full-history render gate, including bootstrap and fallback reads.
  function canRender() {
    checkContext();
    if (messageOpen) { dirty = true; return false; }
    return true;
  }
  function schedule() {
    checkContext();
    clearTimeout(timer); timer = null;
    if (!dirty || messageOpen || flight) return;
    timer = setTimeout(run, Math.max(0, quietMs - (Date.now() - lastEventAt)));
  }
  async function run() {
    timer = null;
    checkContext();
    if (!dirty || messageOpen || flight) return;
    flight = sync();
    try { await flight; }
    finally {
      flight = null;
      // A stale read can also be caused by a transition, not a recent token.
      if (dirty) { lastEventAt = Date.now(); schedule(); }
    }
  }
  function event(value) {
    checkContext();
    if (['workspace_changed', 'runtime_stopping', 'runtime_exit', 'agent_start'].includes(value.type) && !value.renamed) reset();
    if (['message_start', 'message_update'].includes(value.type)) messageOpen = true;
    if (['message_end', 'agent_settled'].includes(value.type)) messageOpen = false;
    if (value.snapshotRequired) dirty = true;
    lastEventAt = Date.now();
    schedule();
  }
  return { event, recovered, canRender };
}
