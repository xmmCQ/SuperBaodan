import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function readBundle(kind) {
  const entries = {
    home: [path.join(ROOT, "app", "renderer", "app.js"), ...(await listFiles(path.join(ROOT, "app", "renderer", "home"), ".js"))],
    assistant: [path.join(ROOT, "app", "renderer", "assistant.js"), ...(await listFiles(path.join(ROOT, "app", "renderer", "assistant"), ".js"))],
    server: [path.join(ROOT, "app/services/main.mjs"), ...(await listFiles(path.join(ROOT, "app/services"), ".mjs"))],
  }[kind];
  if (!entries) throw new Error(`未知源码包：${kind}`);
  const sources = await Promise.all(entries.map(async (file) => `\n// SOURCE: ${path.relative(ROOT, file)}\n${await readFile(file, "utf8")}`));
  return sources.join("\n");
}

async function listFiles(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full, extension));
    else if (entry.name.endsWith(extension)) files.push(full);
  }
  return files;
}
