import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempProject } from "./helpers/temp-project.mjs";
import {
  SkillManager,
  annotateInstall,
  buildSkillCliArgs,
  buildSkillMarkdown,
  parseSkillMarkdown,
  setDisableModelInvocation,
  updateStructuredSkillMarkdown,
  validateSkillName,
  validateSkillPackage,
} from "../lib/skill-manager.mjs";

async function tempRoot(t, prefix) {
  const temp = await createTempProject(prefix);
  t.after(temp.cleanup);
  return temp.root;
}

const sample = `---
name: "bill-helper"
description: "票据业务助手"
custom-field:
  nested: true
---

# 工作流程

保留原有规则。
`;

test("Skill Markdown结构化编辑保留未知frontmatter字段", () => {
  const updated = updateStructuredSkillMarkdown(sample, { description: "新的描述", body: "# 新规则\n\n执行。" });
  assert.match(updated, /custom-field:\n  nested: true/);
  assert.equal(parseSkillMarkdown(updated).description, "新的描述");
  assert.match(updated, /# 新规则/);
});

test("自动调用开关只修改disable-model-invocation", () => {
  const disabled = setDisableModelInvocation(sample, true);
  assert.match(disabled, /disable-model-invocation: true/);
  assert.match(disabled, /custom-field:\n  nested: true/);
  const enabled = setDisableModelInvocation(disabled, false);
  assert.doesNotMatch(enabled, /disable-model-invocation/);
  assert.match(enabled, /保留原有规则/);
});

test("Skill名称和skills.sh包名拒绝路径穿越及参数注入", () => {
  assert.equal(validateSkillName("bill-helper_2"), "bill-helper_2");
  for (const invalid of ["../bad", "a/b", "CON", "-flag", ""]) assert.throws(() => validateSkillName(invalid));
  assert.equal(validateSkillPackage("owner/repo@skill"), "owner/repo@skill");
  for (const invalid of ["--help", "owner/repo --force", "owner/../repo", "https://example.com/a"]) assert.throws(() => validateSkillPackage(invalid));
});

test("npx参数使用数组且范围参数正确", () => {
  assert.deepEqual(buildSkillCliArgs("install", { package: "owner/repo@demo", scope: "project" }), ["skills", "add", "owner/repo@demo", "-y", "--agent", "pi"]);
  assert.deepEqual(buildSkillCliArgs("uninstall", { name: "demo", scope: "global" }), ["skills", "remove", "demo", "-y", "--agent", "pi", "-g"]);
});

test("skills lock被转换为可更新安装信息", () => {
  const info = annotateInstall({ name: "demo" }, { global: { demo: { source: "https://github.com/owner/repo.git", sourceType: "github", skillPath: "skills/demo/SKILL.md", skillFolderHash: "abc" } }, project: {} }, "global");
  assert.equal(info.package, "owner/repo@demo");
  assert.equal(info.scope, "global");
  assert.equal(info.canCheckForUpdates, true);
});

test("自定义Skill可创建、编辑、备份并删除", async (t) => {
  const root = await tempRoot(t, "super-baodan-skill-");
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  const backupDir = path.join(root, "backups");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  const manager = new SkillManager({
    agentDir,
    cwd,
    backupDir,
    env: { USERPROFILE: root },
    piAdmin: { withMaintenance: (operation) => operation() },
    loadSdk: async () => ({ parseFrontmatter: (content) => ({ frontmatter: parseSkillMarkdown(content) }) }),
  });
  await manager.createCustom({ scope: "project", name: "demo", mode: "structured", description: "演示技能", body: "# 初始" });
  const file = path.join(cwd, ".pi", "skills", "demo", "SKILL.md");
  assert.equal(existsSync(file), true);
  await manager.updateCustom({ scope: "project", name: "demo", mode: "structured", description: "已修改", body: "# 更新" });
  assert.equal(parseSkillMarkdown(await readFile(file, "utf8")).description, "已修改");
  await manager.deleteCustom({ scope: "project", name: "demo" });
  assert.equal(existsSync(file), false);
  const backups = await (await import("node:fs/promises")).readdir(backupDir);
  assert.equal(backups.some((name) => name.startsWith("skills-")), true);
});

test("skills.sh安装失败时恢复Skill目录快照", async (t) => {
  const root = await tempRoot(t, "super-baodan-skill-rollback-");
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  const projectRoot = path.join(cwd, ".pi", "skills");
  const keepFile = path.join(projectRoot, "keep", "SKILL.md");
  await mkdir(path.dirname(keepFile), { recursive: true });
  await writeFile(keepFile, buildSkillMarkdown({ name: "keep", description: "原始", body: "# 原始" }));
  const manager = new SkillManager({
    agentDir,
    cwd,
    backupDir: path.join(root, "backups"),
    env: { USERPROFILE: root },
    piAdmin: { withMaintenance: (operation) => operation() },
    execFileImpl: async (_command, args) => {
      if (args.includes("--version")) return { stdout: "11.0.0", stderr: "" };
      await writeFile(keepFile, "损坏");
      const added = path.join(projectRoot, "new-skill");
      await mkdir(added, { recursive: true });
      await writeFile(path.join(added, "SKILL.md"), "部分安装");
      const error = new Error("模拟安装失败"); error.stderr = "模拟安装失败"; throw error;
    },
  });
  await assert.rejects(() => manager.install({ scope: "project", package: "owner/repo@new-skill" }), /模拟安装失败/);
  assert.match(await readFile(keepFile, "utf8"), /# 原始/);
  assert.equal(existsSync(path.join(projectRoot, "new-skill")), false);
});

test("锁记录管理的全局Skill允许受控的官方目录符号链接", async (t) => {
  const root = await tempRoot(t, "super-baodan-skill-managed-link-");
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  const linkedRoot = path.join(agentDir, "skills");
  const canonical = path.join(root, ".agents", "skills", "demo");
  await Promise.all([mkdir(linkedRoot, { recursive: true }), mkdir(canonical, { recursive: true }), mkdir(cwd, { recursive: true })]);
  await writeFile(path.join(canonical, "SKILL.md"), buildSkillMarkdown({ name: "demo", description: "托管技能", body: "# 托管" }));
  try { await symlink(canonical, path.join(linkedRoot, "demo"), "dir"); }
  catch { return t.skip("当前平台不能创建符号链接"); }
  const manager = new SkillManager({ agentDir, cwd, backupDir: path.join(root, "backups"), env: { USERPROFILE: root }, piAdmin: { withMaintenance: (operation) => operation() } });
  await assert.doesNotReject(() => manager.assertSafeManagedSkill({ scope: "global", name: "demo", filePath: path.join(linkedRoot, "demo", "SKILL.md") }));
});

test("自定义Skill拒绝符号链接逃逸", async (t) => {
  const root = await tempRoot(t, "super-baodan-skill-link-");
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  const projectRoot = path.join(cwd, ".pi", "skills");
  const outside = path.join(root, "outside");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(projectRoot, { recursive: true }), mkdir(outside, { recursive: true })]);
  await writeFile(path.join(outside, "SKILL.md"), buildSkillMarkdown({ name: "escape", description: "外部", body: "# 外部" }));
  try { await symlink(outside, path.join(projectRoot, "escape"), "dir"); }
  catch { return t.skip("当前平台不能创建符号链接"); }
  const manager = new SkillManager({
    agentDir,
    cwd,
    backupDir: path.join(root, "backups"),
    env: { USERPROFILE: root },
    piAdmin: { withMaintenance: (operation) => operation() },
    loadSdk: async () => ({ parseFrontmatter: () => ({ frontmatter: {} }) }),
  });
  await assert.rejects(() => manager.updateCustom({ scope: "project", name: "escape", mode: "structured", description: "修改", body: "x" }), /符号链接|真实路径|异常Skill路径/);
});
