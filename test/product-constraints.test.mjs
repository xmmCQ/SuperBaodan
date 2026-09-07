import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBundle } from "./source-bundles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const homeHtml = await readFile(path.join(ROOT, "public/index.html"), "utf8");
const assistantHtml = await readFile(path.join(ROOT, "public/assistant.html"), "utf8");
const assistantSource = await readBundle("assistant");
const serverSource = await readBundle("server");

async function publicSources(directory = path.join(ROOT, "public")) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await publicSources(file));
    else if (/\.(?:html|css|js|mjs)$/.test(entry.name)) output.push([file, await readFile(file, "utf8")]);
  }
  return output;
}

test("产品仅支持电脑端，不保留移动端分支", async () => {
  for (const [file, source] of await publicSources()) {
    assert.doesNotMatch(source, /@media\s*\([^)]*max-width|name=["']viewport|matchMedia\(|@media\s*\([^)]*(?:hover|pointer)|\bmobile-|apple-touch-icon/i, path.relative(ROOT, file));
  }
  assert.doesNotMatch(`${homeHtml}\n${assistantHtml}`, /name=["']viewport/);
});

test("会话分支能力保持移除", async () => {
  const commands = await readFile(path.join(ROOT, "lib/agent-commands.mjs"), "utf8");
  const source = `${assistantHtml}\n${assistantSource}\n${serverSource}\n${commands}`;
  assert.doesNotMatch(source, /get_fork_messages|get_entries|get_tree|\/api\/agent\/fork|branchDialog|forkFromMessage|sessionTree|parentSession/);
});

test("工作区不执行或展示Git状态", async () => {
  const workspace = await readFile(path.join(ROOT, "lib/workspace.mjs"), "utf8");
  assert.doesNotMatch(`${workspace}\n${serverSource}\n${assistantHtml}\n${assistantSource}`, /\/api\/workspace\/changes|workspaceService\.changes|loadWorkspaceChanges|workspaceChanges|data\.git/);
  assert.doesNotMatch(workspace, /async changes\(|\bgit status\b/i);
});

test("工作待办只使用超级宝蛋内部文件", async () => {
  assert.match(serverSource, /todoFile: process\.env\.SUPER_BAODAN_TODO_FILE \|\| path\.join\(dataDir, "work-todo\.md"\)/);
  assert.doesNotMatch(serverSource, /Obsidian Vault/);
  await assert.doesNotReject(access(path.join(ROOT, "data/work-todo.md")));
});
