import { StringDecoder } from "node:string_decoder";
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

export class RotatingLogWriter {
  constructor(file, { maxBytes = 5 * 1024 * 1024, history = 3, maxLineChars = 64 * 1024, now = () => new Date(), onError = () => {} } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.history = history;
    this.maxLineChars = maxLineChars;
    this.now = now;
    this.onError = onError;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.omitted = false;
    this.queue = Promise.resolve();
    this.lastError = null;
  }

  push(chunk) {
    this.consume(this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  }

  consume(text) {
    for (const piece of text.split(/(\r?\n)/)) {
      if (/^\r?\n$/.test(piece)) { this.enqueueLine(); continue; }
      if (this.omitted) continue;
      const room = this.maxLineChars - this.buffer.length;
      if (piece.length <= room) this.buffer += piece;
      else {
        this.buffer += piece.slice(0, Math.max(0, room));
        this.omitted = true;
      }
    }
  }

  enqueueLine() {
    const suffix = this.omitted ? " …[超长输出已省略]" : "";
    const line = redact(this.buffer) + suffix;
    this.buffer = "";
    this.omitted = false;
    this.enqueue(`${this.now().toISOString()} ${line}\n`);
  }

  enqueue(text) {
    this.queue = this.queue.then(() => this.write(text)).catch((error) => {
      this.lastError = error;
      this.onError(error);
    });
  }

  async write(text) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const bytes = Buffer.byteLength(text);
    const size = (await stat(this.file).catch(() => null))?.size || 0;
    if (size && size + bytes > this.maxBytes) await this.rotate();
    await appendFile(this.file, text, "utf8");
  }

  async rotate() {
    await unlink(`${this.file}.${this.history}`).catch(() => {});
    for (let index = this.history - 1; index >= 1; index -= 1) {
      await rename(`${this.file}.${index}`, `${this.file}.${index + 1}`).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await rename(this.file, `${this.file}.1`).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async close() {
    const tail = this.decoder.end();
    if (tail) this.consume(tail);
    if (this.buffer || this.omitted) this.enqueueLine();
    await this.queue;
  }
}

export function redact(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/gi, "$1[凭据已隐藏]")
    .replace(/(\b(?:access_token|refresh_token|id_token|api[_-]?key|secret|token)\b\s*[=:]\s*["']?)[^\s,"'};]+/gi, "$1[凭据已隐藏]")
    .replace(/("(?:access_token|refresh_token|id_token|apiKey|api_key|secret|token)"\s*:\s*")[^"]+/gi, "$1[凭据已隐藏]")
    .replace(/\b(?:sk|rt)\.[A-Za-z0-9._-]{12,}\b/gi, "[凭据已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, "[凭据已隐藏]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]{12,}/gi, "$1[凭据已隐藏]");
}
