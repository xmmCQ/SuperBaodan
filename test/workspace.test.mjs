import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_TEXT_PREVIEW_BYTES, MAX_UPLOAD_FILE_BYTES, WorkspaceService, resolveLexically, validateUploadFiles } from "../lib/workspace.mjs";
import { createTempProject } from "./helpers/temp-project.mjs";

async function harness() {
  const temp = await createTempProject("super-baodan-workspace-");
  const root = temp.root;
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  await writeFile(path.join(workspace, "safe.md"), "# Safe\nhello", "utf8");
  await writeFile(path.join(workspace, "blocked.exe"), "not executable", "utf8");
  await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
  await symlink(path.join(outside, "secret.txt"), path.join(workspace, "escape.txt"));
  const service = await new WorkspaceService(workspace, { log: { warn() {} } }).initialize();
  return { root, workspace, service, cleanup: temp.cleanup };
}

test("workspace paths reject traversal, absolute paths, and symlink escapes", async () => {
  const value = await harness();
  try {
    assert.throws(() => resolveLexically(value.workspace, "../outside/secret.txt"), /路径穿越/);
    assert.throws(() => resolveLexically(value.workspace, path.join(value.root, "outside", "secret.txt")), /相对路径/);
    await assert.rejects(value.service.preview("escape.txt"), /工作区之外/);
    const preview = await value.service.preview("safe.md");
    assert.equal(preview.kind, "markdown");
    assert.match(preview.content, /# Safe/);
  } finally { await value.cleanup(); }
});

test("workspace preview enforces type and text size allowlists", async () => {
  const value = await harness();
  try {
    await assert.rejects(value.service.preview("blocked.exe"), /不允许预览/);
    await writeFile(path.join(value.workspace, "large.txt"), Buffer.alloc(MAX_TEXT_PREVIEW_BYTES + 1, 65));
    await assert.rejects(value.service.preview("large.txt"), /超过大小限制/);
    const results = await value.service.search("safe");
    assert.deepEqual(results.map((entry) => entry.path), ["safe.md"]);
    const binaryResults = await value.service.search("blocked");
    assert.deepEqual(binaryResults.map(({ path: filePath, previewable }) => ({ path: filePath, previewable })), [{ path: "blocked.exe", previewable: false }]);
  } finally { await value.cleanup(); }
});

test("workspace upload validates names, sizes, conflicts and symlink safety", async () => {
  const value = await harness();
  try {
    const check = await value.service.checkUpload("", [{ name: "safe.md", size: 3 }, { name: "new.docx", size: 4 }]);
    assert.deepEqual(check.conflicts, [{ name: "safe.md", kind: "file" }]);
    const created = await value.service.upload("", "new.docx", Buffer.from("docx"));
    assert.deepEqual({ path: created.path, size: created.size, previewable: created.previewable }, { path: "new.docx", size: 4, previewable: false });
    assert.equal(await readFile(path.join(value.workspace, "new.docx"), "utf8"), "docx");
    await assert.rejects(value.service.upload("", "safe.md", Buffer.from("replace")), /同名文件已存在/);
    const overwritten = await value.service.upload("", "safe.md", Buffer.from("replace"), { overwrite: true });
    assert.equal(overwritten.overwritten, true);
    assert.equal(await readFile(path.join(value.workspace, "safe.md"), "utf8"), "replace");
    await assert.rejects(value.service.upload("", "escape.txt", Buffer.from("bad"), { overwrite: true }), /符号链接/);
    assert.throws(() => validateUploadFiles([{ name: "../bad.txt", size: 1 }]), /文件名无效/);
    assert.throws(() => validateUploadFiles([{ name: "CON.txt", size: 1 }]), /保留文件名/);
    assert.throws(() => validateUploadFiles([{ name: "large.bin", size: MAX_UPLOAD_FILE_BYTES + 1 }]), /单个文件不能超过25MB/);
  } finally { await value.cleanup(); }
});

test("workspace tree reports an escaping symlink as unsafe without following it", async () => {
  const value = await harness();
  try {
    const tree = await value.service.tree("", 2);
    const link = tree.entries.find((entry) => entry.name === "escape.txt");
    assert.deepEqual({ kind: link.kind, safe: link.safe }, { kind: "symlink", safe: false });
  } finally { await value.cleanup(); }
});
