export function createAgentEventStream({
  onEvent,
  onStatus = () => {},
  url = "/api/agent/events",
  eventSourceFactory = (sourceUrl) => new EventSource(sourceUrl),
} = {}) {
  if (typeof onEvent !== "function") throw new TypeError("onEvent必须是函数");
  let source = null;
  let connectedOnce = false;

  function connect() {
    if (source) return source;
    onStatus("connecting", { reconnected: false });
    source = eventSourceFactory(url);
    source.onopen = () => {
      const reconnected = connectedOnce;
      connectedOnce = true;
      onStatus("open", { reconnected });
    };
    source.onmessage = (message) => {
      try { onEvent(JSON.parse(message.data)); }
      catch (error) { onStatus("parse_error", { error }); }
    };
    source.onerror = (error) => {
      onStatus("reconnecting", { error, reconnected: connectedOnce });
    };
    return source;
  }

  function close() {
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
