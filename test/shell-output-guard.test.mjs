import test from "node:test";
import assert from "node:assert/strict";
import shellOutputGuard, { hasNulRedirection, shellOutputError } from "../extras/pi-extensions/shell-output-guard/index.js";
import { sdkHarness } from "./helpers/fake-sdk-host.mjs";

test("拦截Bash及PowerShell向nul文件的误重定向", () => {
  for (const command of [
    "where magick 2>nul || where ffmpeg 2>nul || where pngquant 2>nul || where cwebp 2>nul",
    "echo hello > NUL", "echo hello >>nul", "echo hello &>nul", "echo hello 2> 'nul'",
    'echo hello 2>"nul"', "echo hello >./nul", "echo hello >n\\ul", "echo hello >|nul",
  ]) assert.equal(hasNulRedirection(command), true, command);
  assert.equal(hasNulRedirection("Write-Output hello 2>nul", "powershell"), true);
  assert.equal(hasNulRedirection("Write-Output hello >.\\nul", "powershell"), true);
  assert.match(shellOutputError("test 2>nul"), /2>\/dev\/null/);
  assert.match(shellOutputError("test 2>nul", "powershell"), /2>\$null/);
});

test("正确重定向、普通字符串和明确的CMD内部命令不被误拦", () => {
  for (const command of [
    "where magick 2>/dev/null", "echo nul", "cat nul", "echo hello >null", "echo hello >result.txt",
    'echo "不要使用 2>nul"', "echo '2>nul'", 'cmd.exe /c "where magick 2>nul"',
    "echo okay # old example 2>nul", "echo hello 2>&1", "echo \\>nul",
  ]) assert.equal(hasNulRedirection(command), false, command);
  for (const command of ["Get-Command magick 2>$null", "Get-Command magick | Out-Null", "Write-Output '>nul'"]) {
    assert.equal(hasNulRedirection(command, "powershell"), false, command);
  }
});

test("独立扩展同时提供模型规则、工具执行拦截和用户Bash拦截", () => {
  const handlers = new Map();
  shellOutputGuard({ on: (type, callback) => handlers.set(type, callback) });
  assert.match(handlers.get("before_agent_start")({ systemPrompt: "original" }).systemPrompt, /^original[\s\S]*\/dev\/null/);
  assert.equal(handlers.get("tool_call")({ toolName: "bash", input: { command: "where missing 2>nul" } }).block, true);
  assert.equal(handlers.get("tool_call")({ toolName: "read", input: { path: "nul" } }), undefined);
  assert.equal(handlers.get("user_bash")({ command: "where missing 2>nul" }).result.cancelled, true);
});

test("HTTP命令复用Pi的user_bash Hook，无需内置重复拦截", async () => {
  const h = await sdkHarness();
  try {
    await h.runtime.start();
    let executions = 0;
    const handlers = new Map();
    shellOutputGuard({ on: (type, handler) => handlers.set(type, handler) });
    h.hosts[0].session.extensionRunner.emitUserBash = (event) => handlers.get("user_bash")(event);
    h.hosts[0].session.executeBash = async () => { executions += 1; return { output: "ok" }; };
    const blocked = await h.runtime.send({ type: "bash", command: "where missing 2>nul" });
    assert.equal(blocked.cancelled, true);
    assert.match(blocked.output, /已阻止命令/);
    assert.equal(executions, 0);
    await h.runtime.send({ type: "bash", command: "where missing 2>/dev/null" });
    assert.equal(executions, 1);
  } finally { await h.cleanup(); }
});
