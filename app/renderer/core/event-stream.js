import { invoke } from './service-client.js?v=1';

export function createAgentEventStream({
  onEvent,
  onStatus = () => {},
  request = invoke,
  bridge = globalThis.window?.workbench,
  captureContext = () => () => true,
} = {}) {
  if (typeof onEvent !== "function") throw new TypeError("onEvent必须是函数");
  let source = null;
  let connectedOnce = false, generation = 0, pending = null, sessionId = null;
  let queued = [];
  function reset() { generation += 1; pending = null; queued = []; }
  function dispatch(event) {
    if (event.type !== 'extension_ui_payload') { onEvent(event); return; }
    const epoch = generation, current = captureContext();
    const flight = request("agent.uiPayload", { token: event.token, workspaceId: event.workspaceId }, { timeout: 15000 });
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

  function connect() {
    if (source) return source;
    onStatus("connecting", { reconnected: false });
    if (!bridge) throw new Error("应用事件接口不可用");
    source = { close() { unsubscribe(); statusUnsubscribe(); } };
    const deliver = event => source?.onmessage?.({ data: JSON.stringify(event) });
    const initialize = () => request('agent.connect', {}).then(events => {
      if (!source) return;
      const reconnected = connectedOnce; connectedOnce = true;
      onStatus("open", { reconnected });
      for (const event of events) deliver(event);
    }).catch(error => onStatus("reconnecting", { error, reconnected: connectedOnce }));
    const unsubscribe = bridge.onEvent(({ topic, event }) => { if (topic === 'agent') deliver(event); });
    const statusUnsubscribe = bridge.onBackendStatus(status => {
      if (status.state === 'connected') void initialize();
      else if (status.state === 'disconnected') { reset(); onStatus('reconnecting', { reconnected: connectedOnce }); }
    });
    void initialize();
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if ((event.type === 'workspace_changed' && !event.renamed) || ['runtime_stopping', 'connected'].includes(event.type) || (event.type === 'runtime_ready' && sessionId && sessionId !== event.state?.sessionId)) reset();
        if (event.type === 'runtime_ready') sessionId = event.state?.sessionId || null;
        if (pending) {
          if (queued.length >= 128) {
            const backlog = queued;
            reset();
            for (const item of backlog) if (item.type !== "extension_ui_payload") onEvent(item);
            onEvent({ type: 'extension_error', error: '扩展界面取回期间事件积压，请重新同步对话', snapshotRequired: true });
            dispatch(event);
          } else queued.push(event);
        } else dispatch(event);
      }
      catch (error) { onStatus("parse_error", { error }); }
    };
    source.onerror = (error) => {
      reset();
      onStatus("reconnecting", { error, reconnected: connectedOnce });
    };
    return source;
  }

  function close() {
    reset();
    if (!source) return;
    const closing = source;
    source = null;
    closing.onopen = null;
    closing.onmessage = null;
    closing.onerror = null;
    closing.close();
    onStatus("closed", { reconnected: connectedOnce });
  }

  return {
    connect,
    close,
    connected: () => Boolean(source),
  };
}
