import { invoke } from './service-client.js?v=1';

export function createAgentEventStream({
  onEvent,
  onStatus = () => {},
  request = invoke,
  bridge = globalThis.window?.workbench,
  captureContext = () => () => true,
} = {}) {
  if (typeof onEvent !== 'function') throw new TypeError('onEvent必须是函数');
  let connection = null, connectedOnce = false;
  let generation = 0, pending = null, sessionId = null, queued = [];
  function reset() { generation++; pending = null; queued = []; }
  function dispatch(event) {
    if (event.type !== 'extension_ui_payload') { onEvent(event); return; }
    const epoch = generation, current = captureContext();
    const flight = request('agent.uiPayload', { token: event.token, workspaceId: event.workspaceId }, { timeout: 15000 });
    pending = flight;
    void flight.then(body => {
      if (epoch === generation && current()) onEvent(body);
    }).catch(error => {
      if (epoch === generation && current()) onEvent({ type: 'extension_error', error: `扩展界面取回失败：${error.message}；请重试，未完成交互将在超时后取消` });
    }).finally(() => {
      if (pending !== flight) return;
      pending = null;
      if (!current()) { queued = []; return; }
      while (!pending && queued.length) {
        try { dispatch(queued.shift()); } catch (error) { onStatus('parse_error', { error }); }
      }
    });
  }
  function deliver(event) {
    try {
      if ((event.type === 'workspace_changed' && !event.renamed) || ['runtime_stopping', 'runtime_exit', 'connected'].includes(event.type) || (event.type === 'runtime_ready' && sessionId && sessionId !== event.state?.sessionId)) reset();
      if (event.type === 'runtime_ready') sessionId = event.state?.sessionId || null;
      if (!pending) { dispatch(event); return; }
      if (queued.length < 128) { queued.push(event); return; }
      const backlog = queued; reset();
      for (const item of backlog) if (item.type !== 'extension_ui_payload') onEvent(item);
      onEvent({ type: 'extension_error', error: '扩展界面取回期间事件积压，请重新同步对话', snapshotRequired: true });
      dispatch(event);
    } catch (error) { onStatus('parse_error', { error }); }
  }
  function connect() {
    if (connection) return connection;
    if (!bridge) throw new Error('应用事件接口不可用');
    onStatus('connecting', { reconnected: false });
    const active = { sequence: 0, revision: 0, dispose: () => {} };
    connection = active;
    const initialize = () => {
      const sequence = ++active.sequence, revision = active.revision;
      const current = () => connection === active && sequence === active.sequence;
      return request('agent.connect', {}).then(events => {
        if (!current()) return;
        const reconnected = connectedOnce; connectedOnce = true;
        onStatus('open', { reconnected });
        // Never apply a snapshot captured before a live workspace/session change.
        if (revision !== active.revision) return;
        for (const event of events) { if (!current()) break; deliver(event); }
      }).catch(error => { if (current()) onStatus('reconnecting', { error, reconnected: connectedOnce }); });
    };
    const unsubscribe = bridge.onEvent(({ topic, event }) => {
      if (connection !== active || topic !== 'agent') return;
      if (['workspace_changed', 'runtime_ready', 'runtime_stopping', 'runtime_exit', 'agent_start', 'agent_settled'].includes(event.type)) active.revision++;
      deliver(event);
    });
    const unsubscribeStatus = bridge.onBackendStatus(status => {
      if (connection !== active) return;
      if (status.state === 'connected') void initialize();
      else if (status.state === 'disconnected') {
        active.sequence++; active.revision++; reset();
        onStatus('reconnecting', { reconnected: connectedOnce });
      }
    });
    active.dispose = () => { unsubscribe(); unsubscribeStatus(); };
    void initialize();
    return active;
  }
  function close() {
    reset();
    if (!connection) return;
    const previous = connection; connection = null;
    previous.dispose();
    onStatus('closed', { reconnected: connectedOnce });
  }
  return { connect, close, connected: () => Boolean(connection) };
}
