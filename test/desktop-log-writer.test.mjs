import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RotatingLogWriter } from "../app/main/log-writer.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sb-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "server.log");
}

test("跨数据块的中文和密钥按完整行解码并脱敏", async (t) => {
  const file = await fixture(t); const writer = new RotatingLogWriter(file);
  const bytes = Buffer.from('中文 Authorization: Bearer secret-token-value-123456\n{"access_token":"oauth-secret-value"}\n');
  for (let index = 0; index < bytes.length; index += 3) writer.push(bytes.subarray(index, index + 3));
  await writer.close(); const output = await readFile(file, "utf8");
  assert.match(output, /中文/); assert.doesNotMatch(output, /secret-token|oauth-secret/);
  assert.match(output, /凭据已隐藏/);
});

test("超长无换行输出被截断且不会绕过脱敏", async (t) => {
  const file = await fixture(t); const writer = new RotatingLogWriter(file, { maxLineChars: 64 });
  writer.push(`api_key=very-secret-value-${"x".repeat(300)}`); await writer.close();
  const output = await readFile(file, "utf8");
  assert.doesNotMatch(output, /very-secret/); assert.match(output, /超长输出已省略/); assert.ok(output.length < 180);
});

test("日志串行写入并按上限轮转", async (t) => {
  const file = await fixture(t); const writer = new RotatingLogWriter(file, { maxBytes: 90, history: 3 });
  for (const item of ["first", "second", "third", "fourth", "fifth"]) writer.push(`${item}\n`);
  await writer.close(); const files = await readdir(path.dirname(file));
  assert.ok(files.includes("server.log")); assert.ok(files.some((name) => name.startsWith("server.log.")));
  const combined = (await Promise.all(files.filter((name) => name.startsWith("server.log")).sort().map((name) => readFile(path.join(path.dirname(file), name), "utf8")))).join("\n");
  for (const item of ["first", "second", "third", "fourth", "fifth"]) assert.match(combined, new RegExp(item));
});

test("日志写入失败不抛出到主流程", async (t) => {
  const target = await fixture(t); const blocked = path.join(path.dirname(target), "blocked"); await writeFile(blocked, "file");
  let reported = null; const writer = new RotatingLogWriter(path.join(blocked, "server.log"), { onError: (error) => { reported = error; } });
  writer.push("message\n"); await assert.doesNotReject(writer.close()); assert.ok(reported); assert.ok(writer.lastError);
});
