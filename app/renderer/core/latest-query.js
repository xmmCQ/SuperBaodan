// Independent instances share the same cancel/sequence/scope rules.
export function createLatestQuery({ query, scope, request, publish, clear, onError = () => {} }) {
  let sequence = 0, controller, timer;
  function cancel() { ++sequence; clearTimeout(timer); controller?.abort(); controller = null; clear(); }
  function run(delay = 0) {
    cancel();
    const value = query(), owner = scope(), serial = sequence;
    if (!value) return Promise.resolve();
    const abort = new AbortController(); controller = abort;
    const current = () => serial === sequence && !abort.signal.aborted && owner === scope() && value === query();
    const execute = async () => {
      if (!current()) return;
      try { const data = await request(value, abort.signal); if (current()) publish(data); }
      catch (error) { if (current()) onError(error); }
    };
    if (delay) { timer = setTimeout(execute, delay); return; }
    return execute();
  }
  return { run, cancel };
}
