import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBundle } from "./source-bundles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function filesIn(relative, extension) {
  const dir = path.join(ROOT, relative);
  return (await readdir(dir)).filter((name) => name.endsWith(extension)).map((name) => path.join(dir, name));
}

async function source(file) { return readFile(file, "utf8"); }

function imports(text) {
  return [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
}

test("首页和展开助手入口只负责加载模块化 main", async () => {
  for (const [entry, expected] of [["app.js", "/home/main.js"], ["assistant.js", "/assistant/main.js"]]) {
    const text = await source(path.join(ROOT, "public", entry));
    const specifier = text.match(/^import\s+["']([^"']+)["'];?\s*$/)?.[1];
    assert.equal(new URL(specifier, "http://test.local").pathname, expected);
  }
});

test("前端业务模块均不超过500行且状态按领域分片", async () => {
  const files = [...await filesIn("public/home", ".js"), ...await filesIn("public/assistant", ".js")];
  for (const file of files) {
    const lines = (await source(file)).split("\n").length - 1;
    assert.ok(lines <= 500, `${path.relative(ROOT, file)}有${lines}行`);
  }
  const homeState = await source(path.join(ROOT, "public/home/state.js"));
  const assistantState = await source(path.join(ROOT, "public/assistant/state.js"));
  for (const slice of ["planner", "chat", "records", "vskills"]) assert.match(homeState, new RegExp(`${slice}:`));
  for (const slice of ["chat", "sessions", "models", "auth", "skills", "workspace"]) assert.match(assistantState, new RegExp(`${slice}:`));
});

test("前端领域模块无循环 import，main只做装配和协调", async () => {
  for (const folder of ["home", "assistant"]) {
    const files = await filesIn(`public/${folder}`, ".js");
    const graph = new Map();
    for (const file of files) {
      const dependencies = imports(await source(file))
        .map((item) => new URL(item, "http://test.local").pathname)
        .filter((item) => item.startsWith(`/${folder}/`))
        .map((item) => path.basename(item));
      graph.set(path.basename(file), dependencies);
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (file) => {
      if (visiting.has(file)) throw new Error(`${folder}模块存在循环依赖：${file}`);
      if (visited.has(file)) return;
      visiting.add(file);
      for (const dependency of graph.get(file) || []) visit(dependency);
      visiting.delete(file);
      visited.add(file);
    };
    for (const file of graph.keys()) visit(file);
    const main = await source(path.join(ROOT, "public", folder, "main.js"));
    assert.ok(imports(main).filter((item) => item.startsWith(`/${folder}/`)).length >= 4);
    assert.ok(main.split("\n").length - 1 < 500);
  }
});

test("请求和DOM渲染职责分离在控制器工厂边界内", async () => {
  const homeDashboard = await source(path.join(ROOT, "public/home/dashboard.js"));
  const assistantSkills = await source(path.join(ROOT, "public/assistant/skills-controller.js"));
  assert.match(homeDashboard, /createDashboard\(\{[\s\S]*api/);
  assert.match(assistantSkills, /createSkillsController\(\{[\s\S]*api/);
  assert.doesNotMatch(await source(path.join(ROOT, "public/home/state.js")), /document\.|\bapi\(/);
  assert.doesNotMatch(await source(path.join(ROOT, "public/assistant/state.js")), /document\.|\bapi\(/);
});

test("server.mjs保持轻量并通过显式运行时上下文注册路由", async () => {
  const rootServer = await source(path.join(ROOT, "server.mjs"));
  assert.ok(rootServer.split("\n").length - 1 <= 150);
  assert.match(rootServer, /createRuntimeContext\(config\)/);
  assert.match(rootServer, /createServerApplication\(context\)/);
  const runtime = await source(path.join(ROOT, "server/runtime-context.mjs"));
  for (const field of ["taskMutationQueue", "workspaceSwitchQueue", "workspaceSwitching", "eventClients", "turnFiles"]) assert.match(runtime, new RegExp(`this\\.${field}`));
  const routes = await filesIn("server/routes", ".mjs");
  for (const file of routes) assert.doesNotMatch(await source(file), /^const\s+\w+\s*=\s*new\s+(?:Pi|Skill|Workspace|VSkill)/m, path.basename(file));
});

test("模块化路由保留全部业务API组和安全中间件", async () => {
  const server = await readBundle("server");
  for (const prefix of ["/api/health", "/api/agent/", "/api/sessions", "/api/auth/", "/api/models/", "/api/skills", "/api/vskills", "/api/daily-records", "/api/workspaces", "/api/workspace/", "/api/tasks", "/api/apps/open-all"]) assert.match(server, new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(server, /assertSecureJsonMutation/);
  assert.match(server, /assertSecureBinaryMutation/);
  assert.match(server, /工作区正在切换，请稍后重试/);
  assert.match(server, /任务完成后再切换工作区/);
}
);
