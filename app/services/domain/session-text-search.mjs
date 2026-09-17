import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import path from "node:path";
import { assertSessionPath, sameSessionPath } from "./pi-session-store.mjs";

const DEFAULTS = { maxMs: 2000, maxBytes: 16 * 1024 * 1024, maxFiles: 300, maxResults: 50, maxLineBytes: 512 * 1024 };
const clamp = (value, fallback) => Math.max(1, Math.min(fallback, Number(value) || fallback));

// A fresh, cancellable scan, independent of the metadata list scan. Reading the
// list first would consume an unbounded budget before text search even starts.
export async function searchSessionText({ sessionDir, workspaceRoot, query, signal, budget = {} }) {
  query = String(query || "").trim();
  if (!query || query.length > 200) throw Object.assign(new Error("搜索关键词应为1至200个字符"), { statusCode: 400 });
  const limits = Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, clamp(budget[key], value)]));
  const started = Date.now(), needle = query.toLocaleLowerCase();
  const result = { query, hits: [], complete: true, reasons: [], scannedFiles: 0, scannedBytes: 0 };
  const reasons = new Set();
  const controller = new AbortController();
  let exhausted = false;
  const stop = (reason) => { reasons.add(reason); exhausted = true; controller.abort(); };
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => stop("time_budget"), limits.maxMs);
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() - started >= limits.maxMs) stop("time_budget");
    return !exhausted;
  };
  try {
    const dirs = [path.resolve(sessionDir)];
    for (let index = 0; index < dirs.length && check(); index += 1) {
      let directory;
      try { directory = await opendir(dirs[index]); }
      catch (error) { if (error.code !== "ENOENT") reasons.add("unreadable_file"); continue; }
      for await (const entry of directory) {
        if (!check()) break;
        const file = path.join(dirs[index], entry.name);
        if (entry.isDirectory()) { dirs.push(file); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        if (result.scannedFiles >= limits.maxFiles) { stop("file_budget"); break; }
        result.scannedFiles += 1;
        const fileHits = [];
        let firstText = "", name = "";
        try {
          await assertSessionPath(file, sessionDir);
          if (!check()) break;
          const before = await stat(file);
          let header, messageIndex = 0, indexKnown = true;
          for await (const { line, lineNumber, oversized } of boundedLines(file, controller.signal, limits, (bytes) => {
            result.scannedBytes += bytes;
            if (result.scannedBytes > limits.maxBytes) stop("byte_budget");
          })) {
            if (!check()) break;
            if (oversized) { reasons.add("oversized_line"); if (!header) break; indexKnown = false; continue; }
            if (!line.trim()) continue;
            let row;
            try { row = JSON.parse(line.replace(/^\uFEFF/, "")); }
            catch { reasons.add("malformed_record"); if (!header) break; indexKnown = false; continue; }
            if (!header) {
              if (row.type !== "session" || typeof row.id !== "string" || typeof row.cwd !== "string") { reasons.add("malformed_header"); break; }
              header = row;
              // Do not inspect or expose another workspace's message text.
              if (!sameSessionPath(header.cwd, workspaceRoot)) break;
              continue;
            }
            if (row.type === "session_info" && typeof row.name === "string") name = row.name.slice(0, 120);
            if (row.type !== "message") continue;
            const currentIndex = indexKnown ? messageIndex++ : null;
            const message = row.message;
            if (!["user", "assistant"].includes(message?.role)) continue;
            const text = searchableText(message);
            if (!firstText && message.role === "user") firstText = text.slice(0, 60);
            const matchIndex = text.toLocaleLowerCase().indexOf(needle);
            if (matchIndex < 0) continue;
            const start = Math.max(0, matchIndex - 60), end = Math.min(text.length, matchIndex + query.length + 120);
            fileHits.push({
              sessionId: header.id, sessionPath: file, entryId: typeof row.id === "string" ? row.id : null,
              lineNumber, messageIndex: currentIndex, role: message.role,
              timestamp: message.timestamp ?? row.timestamp ?? null,
              snippet: `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
            });
            if (result.hits.length + fileHits.length >= limits.maxResults) { stop("result_budget"); break; }
          }
          const after = await stat(file);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) reasons.add("file_changed");
        } catch (error) {
          signal?.throwIfAborted();
          if (!exhausted) reasons.add("unreadable_file");
        } finally {
          for (const hit of fileHits) result.hits.push({ ...hit, title: name || firstText || "历史对话" });
        }
      }
    }
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", cancel);
  }
  signal?.throwIfAborted();
  result.reasons = [...reasons]; result.complete = !reasons.size;
  result.elapsedMs = Date.now() - started;
  return result;
}

export function searchableText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

// Bound each JSONL record: an embedded Base64 image must not allocate an entire
// multi-megabyte string. Oversized/partial records make completeness explicit.
async function* boundedLines(file, signal, limits, account) {
  const input = createReadStream(file, { highWaterMark: 16 * 1024, signal });
  let parts = [], size = 0, oversized = false, lineNumber = 0;
  try {
    for await (const chunk of input) {
      account(chunk.length);
      if (signal.aborted) break;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        size += part.length;
        if (size > limits.maxLineBytes) { oversized = true; parts = []; }
        else if (!oversized) parts.push(part);
        if (newline >= 0) {
          yield { line: oversized ? "" : Buffer.concat(parts).toString("utf8"), lineNumber: ++lineNumber, oversized };
          parts = []; size = 0; oversized = false;
        }
        start = newline < 0 ? chunk.length : newline + 1;
      }
    }
    if (!signal.aborted && (size || oversized)) yield { line: oversized ? "" : Buffer.concat(parts).toString("utf8"), lineNumber: ++lineNumber, oversized };
  } finally { input.destroy(); }
}
