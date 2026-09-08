import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { SessionListScanner, readSessionMetadata } from "../lib/pi-session-store.mjs";
import { createTempProject } from "./helpers/temp-project.mjs";

const transcript = (id, text = "hello") => [
  JSON.stringify({ type: "session", id, cwd: "workspace" }),
  JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "image", data: "ignored" }, { type: "text", text }] } }),
].join("\n") + "\n";

test("未变文件不重读，并发列表共用扫描，返回值不污染缓存", async () => {
  const temp = await createTempProject();
  let reads = 0, active = 0, peak = 0;
  const scanner = new SessionListScanner(temp.root, { readMetadata: async (...args) => {
    reads += 1; peak = Math.max(peak, ++active);
    try { return await readSessionMetadata(...args); } finally { active -= 1; }
  } });
  try {
    for (let i = 0; i < 10; i += 1) await temp.write(`nested/${i}.jsonl`, transcript(String(i)));
    const results = await Promise.all([scanner.list(), scanner.list(), scanner.list()]);
    assert.equal(reads, 10); assert.ok(peak <= 4);
    assert.equal(results[0].length, 10);
    results[0][0].title = "changed by caller";
    assert.notEqual(results[1][0].title, "changed by caller");
    await scanner.list(); assert.equal(reads, 10);
  } finally { await temp.cleanup(); }
});

test("新建、追加、外部同大小编辑及删除更新元信息", async () => {
  const temp = await createTempProject();
  let reads = 0;
  const scanner = new SessionListScanner(temp.root, { readMetadata: (...args) => { reads += 1; return readSessionMetadata(...args); } });
  try {
    const file = await temp.write("a.jsonl", transcript("a"));
    await scanner.list();
    await temp.write("b.jsonl", transcript("b"));
    assert.equal((await scanner.list()).length, 2); assert.equal(reads, 2);
    await appendFile(file, '{"type":"session_info","name":"first"}\n');
    assert.equal((await scanner.list()).find((s) => s.id === "a").name, "first");
    const updated = transcript("a") + '{"type":"session_info","name":"other"}\n';
    const before = await stat(file);
    await writeFile(file, updated);
    await utimes(file, before.atime, new Date(before.mtimeMs + 2000));
    assert.equal((await scanner.list()).find((s) => s.id === "a").name, "other");
    await unlink(file);
    assert.equal((await scanner.list()).length, 1);
    assert.equal(scanner.cache.size, 1);
  } finally { await temp.cleanup(); }
});

test("主动失效可识别相同stat；扫描中失效不会把旧值写回", async () => {
  const temp = await createTempProject();
  let calls = 0, invalidateDuringRead = false;
  const scanner = new SessionListScanner(temp.root, { readMetadata: async (file, info) => {
    calls += 1;
    const result = await readSessionMetadata(file, info);
    if (invalidateDuringRead) {
      invalidateDuringRead = false;
      await appendFile(file, '{"type":"session_info","name":"latest"}\n');
      scanner.invalidate(file);
    }
    return result;
  } });
  try {
    const file = await temp.write("a.jsonl", transcript("a"));
    await scanner.list();
    scanner.invalidate(file);
    await scanner.list(); assert.equal(calls, 2);
    scanner.invalidate(file); invalidateDuringRead = true;
    assert.equal((await scanner.list())[0].name, "latest");
    const completed = calls;
    assert.equal((await scanner.list())[0].name, "latest"); assert.equal(calls, completed);
  } finally { await temp.cleanup(); }
});

test("逐行处理BOM、CRLF、残缺尾行；摘要受限且保留消息数", async () => {
  const temp = await createTempProject();
  try {
    await temp.write("a.jsonl", "\uFEFF" + transcript("a", "中".repeat(20000)).replaceAll("\n", "\r\n") + '{"type":"message","message":{"role":"assistant","content":"ok"}}\r\n{"type":');
    const scanner = new SessionListScanner(temp.root);
    const result = (await scanner.list())[0];
    assert.equal(result.firstMessage.length, 240);
    assert.equal(result.title.length, 60);
    assert.equal(result.messageCount, 2);
    assert.equal(JSON.stringify([...scanner.cache.values()]).includes("ignored"), false);
  } finally { await temp.cleanup(); }
});
