import { fault } from '../shared/errors.js';
import { randomUUID } from 'node:crypto';


export const MAX_UI_EVENT_BYTES = 4 * 1024 * 1024;
// Returned JSON values can be as large as an accepted UI event; reserve space
// for response type, request ID and workspace metadata without lifting other commands.
export const MAX_UI_RESPONSE_BYTES = MAX_UI_EVENT_BYTES + 16 * 1024;

// Only oversized extension UI bodies are retained here. Pending questions reuse
// the runtime's existing request objects; notifications need a short-lived copy.
export class UiEventPayloads {
  constructor({ maxItemBytes = MAX_UI_EVENT_BYTES, maxBytes = 8 * 1024 * 1024, maxItems = 16, ttlMs = 60000, onFailure = () => {} } = {}) {
    Object.assign(this, { maxItemBytes, maxBytes, maxItems, ttlMs, onFailure });
    this.items = new Map(); this.bytes = 0;
  }
  put(event, runtime, epoch, workspaceId) {
    for (const [token, item] of this.items) {
      if (item.runtime === runtime && item.bridge === runtime.uiBridge && item.id === event.id && item.epoch === epoch) return { type: 'extension_ui_payload', token, workspaceId };
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > this.maxItemBytes || bytes + this.bytes > this.maxBytes || this.items.size >= this.maxItems) {
      runtime.uiBridge?.respond({ id: event.id, cancelled: true });
      return { type: 'extension_error', error: '扩展界面内容超出传输容量，交互已取消，请缩小内容后重试' };
    }
    const token = randomUUID(), bridge = runtime.uiBridge;
    const pending = runtime.pendingUiRequests().some(request => request.id === event.id);
    const item = { id: event.id, runtime, bridge, epoch, workspaceId, bytes, event: pending ? null : event };
    item.timer = setTimeout(() => {
      this.remove(token);
      const unfinished = bridge === runtime.uiBridge && (pending ? runtime.pendingUiRequests().some(request => request.id === item.id) : !item.fetched);
      if (!unfinished) return;
      bridge?.respond({ id: item.id, cancelled: true });
      this.onFailure({ type: 'extension_error', error: '扩展界面内容取回已过期，未完成的交互已取消，请重试' });
    }, this.ttlMs);
    item.timer.unref?.(); this.items.set(token, item); this.bytes += bytes;
    return { type: 'extension_ui_payload', token, workspaceId };
  }
  get(token, runtime, epoch, workspaceId) {
    const item = this.items.get(token);
    if (!item || item.runtime !== runtime || item.bridge !== runtime.uiBridge || item.epoch !== epoch || item.workspaceId !== workspaceId) throw fault(410, '扩展界面内容已失效，请重试');
    const event = item.event || runtime.pendingUiRequests().find(request => request.id === item.id);
    if (!event) throw fault(410, '扩展交互已结束');
    item.fetched = true;
    return event;
  }
  remove(token) {
    const item = this.items.get(token);
    if (!item) return;
    clearTimeout(item.timer); this.bytes -= item.bytes; this.items.delete(token);
  }
  clear() { for (const token of this.items.keys()) this.remove(token); }
}
