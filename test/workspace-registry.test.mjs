import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { WorkspaceRegistry, samePath, validateName } from "../lib/workspace-registry.mjs";
import { createTempProject } from "./helpers/temp-project.mjs";

async function harness() {
  const temp = await createTempProject("super-baodan-registry-");
  const root = temp.root;
  const defaultRoot = path.join(root, "default");
  const secondRoot = path.join(root, "second");
  const backupDir = path.join(root, "backups");
  const filePath = path.join(root, "data", "workspaces.json");
  await Promise.all([mkdir(defaultRoot), mkdir(secondRoot)]);
  const registry = await new WorkspaceRegistry({ filePath, backupDir, defaultRoot, log: { warn() {} } }).initialize();
  return { root, defaultRoot, secondRoot, filePath, registry, cleanup: temp.cleanup };
}

test("workspace registry seeds and protects the default workspace", async () => {
  const value = await harness();
  try {
    const listed = await value.registry.list();
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].isDefault, true);
    assert.equal(listed.activeWorkspaceId, listed.items[0].id);
    await assert.rejects(value.registry.remove(listed.items[0].id), /默认工作区不能移除/);
    const stored = JSON.parse(await readFile(value.filePath, "utf8"));
    assert.equal(stored.version, 1);
  } finally { await value.cleanup(); }
});

test("workspace registry adds, renames, activates and removes local directories", async () => {
  const value = await harness();
  try {
    const created = await value.registry.add({ name: "业务资料", path: value.secondRoot });
    assert.equal(created.name, "业务资料");
    await assert.rejects(value.registry.add({ name: "其他名称", path: value.secondRoot }), /已经添加/);
    await assert.rejects(value.registry.add({ name: "业务资料", path: value.defaultRoot }), /已经添加/);
    const nested = path.join(value.defaultRoot, "nested");
    await mkdir(nested);
    await assert.rejects(value.registry.add({ name: "嵌套目录", path: nested }), /不能互相包含/);
    const renamed = await value.registry.rename(created.id, "票据项目");
    assert.equal(renamed.name, "票据项目");
    await value.registry.setActive(created.id, "session-2");
    assert.equal(value.registry.active().lastSessionId, "session-2");
    await assert.rejects(value.registry.remove(created.id), /先切换/);
    const defaultId = (await value.registry.list()).items.find((item) => item.isDefault).id;
    await value.registry.setActive(defaultId);
    assert.deepEqual(await value.registry.remove(created.id), { removed: true, id: created.id });
  } finally { await value.cleanup(); }
});

test("workspace registry validates names, absolute paths and directory browsing", async () => {
  const value = await harness();
  try {
    assert.throws(() => validateName(" "), /1至60/);
    await assert.rejects(value.registry.add({ name: "bad", path: "relative" }), /绝对路径/);
    const browsed = await value.registry.browse(value.root);
    assert.ok(browsed.directories.some((entry) => entry.name === "default"));
    assert.equal(samePath(value.defaultRoot, `${value.defaultRoot}${path.sep}`), true);
    assert.equal(samePath("C:\\Work", "c:\\work", "win32"), true);
  } finally { await value.cleanup(); }
});

test("workspace registry falls back to default when the last active directory disappears", async () => {
  const value = await harness();
  try {
    const created = await value.registry.add({ name: "临时工作区", path: value.secondRoot });
    await value.registry.setActive(created.id);
    await rm(value.secondRoot, { recursive: true, force: true });
    const reloaded = await new WorkspaceRegistry({ filePath: value.filePath, backupDir: path.join(value.root, "backups-2"), defaultRoot: value.defaultRoot, log: { warn() {} } }).initialize();
    assert.equal(reloaded.active().isDefault, true);
    assert.match(reloaded.fallbackWarning, /已切换到默认工作区/);
    const missing = (await reloaded.list()).items.find((item) => item.id === created.id);
    assert.equal(missing.available, false);
  } finally { await value.cleanup(); }
});

test("workspace registry remembers an unchanged session without rewriting data", async () => {
  const value = await harness();
  try {
    const active = value.registry.active();
    await value.registry.rememberSession(active.id, "same-session");
    const first = await readFile(value.filePath, "utf8");
    await value.registry.rememberSession(active.id, "same-session");
    assert.equal(await readFile(value.filePath, "utf8"), first);
  } finally { await value.cleanup(); }
});
