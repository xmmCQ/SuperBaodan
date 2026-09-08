import { createHash } from "node:crypto";
import { publicErrorMessage } from "./response.mjs";

// Bounded, process-local admission receipts. An absent receipt is UNKNOWN,
// never proof that a disconnected request was not accepted. No prompt retained.
export class PromptReceipts {
  constructor({ limit = 256, ttlMs = 15 * 60 * 1000 } = {}) {
    this.items = new Map(); this.limit = limit; this.ttlMs = ttlMs;
  }
  prune() {
    const now = Date.now();
    for (const [id, item] of this.items) if (item.status !== "pending" && now - item.updatedAt > this.ttlMs) this.items.delete(id);
  }
  get(id) {
    this.prune();
    const item = this.items.get(id);
    return item ? { requestId: id, status: item.status, error: item.error, updatedAt: item.updatedAt } : { requestId: id, status: "unknown" };
  }
  submit(id, payload, operation) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(id)) throw Object.assign(new Error("消息请求标识无效"), { statusCode: 400 });
    this.prune();
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const previous = this.items.get(id);
    if (previous) {
      if (previous.hash !== hash) throw Object.assign(new Error("消息请求标识已用于其他内容"), { statusCode: 409 });
      return previous.promise;
    }
    if (this.items.size >= this.limit) throw Object.assign(new Error("消息受理记录已满，请稍后再试"), { statusCode: 429 });
    const item = { hash, status: "pending", updatedAt: Date.now() };
    this.items.set(id, item);
    item.promise = Promise.resolve().then(operation).then((result) => {
      item.status = "accepted"; item.updatedAt = Date.now(); return result;
    }, (error) => {
      item.status = "rejected"; item.error = publicErrorMessage(error); item.updatedAt = Date.now(); throw error;
    });
    return item.promise;
  }
}
