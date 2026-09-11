import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { PiSdkRuntime } from "../lib/pi-sdk.mjs";
import { findSdkEntry } from "../lib/pi-sdk-factory.mjs";
import { createTempProject } from "./helpers/temp-project.mjs";

// Explicit opt-in: uses installed Windows SDK, but only isolated test resources.
// No personal credentials, paid model requests or production session changes.
test("真实Windows SDK：扩展UI、工具、会话恢复、设置维护及释放", {
  skip: process.platform !== "win32" || process.env.SUPER_BAODAN_TEST_SDK !== "1" || !findSdkEntry(),
  timeout: 45000,
}, async () => {
  const temp = await createTempProject("super-baodan-sdk-integration-");
  const oldOffline = process.env.PI_OFFLINE;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_OFFLINE = "1";
  let modelRequests = 0;
  let sawProjectPrompt = false;
  const modelServer = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    modelRequests += 1;
    if (request.messages.some(item => JSON.stringify(item.content).includes('PROJECT_PROMPT_LIVE_MARKER'))) sawProjectPrompt = true;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    // Local deterministic provider: first turn calls read; next turn replies.
    setTimeout(() => {
      if (request.messages.some((item) => item.role === "tool")) {
        send({ role: "assistant", content: "已读取SDK中文文件" }); send({}, "stop");
      } else {
        send({ role: "assistant", tool_calls: [
          { index: 0, id: "fixture-tool", type: "function", function: { name: "read", arguments: '{"path":"input.txt"}' } },
          { index: 1, id: "fixture-nul", type: "function", function: { name: "powershell", arguments: JSON.stringify({ command: "Write-Output 'blocked' >nul" }) } },
        ] });
        send({}, "tool_calls");
      }
      res.end("data: [DONE]\n\n");
    }, 40);
  });
  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  await temp.ensureDir("workspace");
  await temp.writeJson("agent/settings.json", { defaultProvider: "fixture", defaultModel: "fixture", enabledModels: ["fixture/*"], defaultTools: ["read", "write", "powershell"], packages: [] });
  await temp.writeJson("agent/models.json", { providers: { fixture: {
    baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, api: "openai-completions", apiKey: "fixture-only-not-a-secret",
    models: [{ id: "fixture", name: "Local fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } });
  await temp.write("workspace/input.txt", "SDK中文文件读取");
  // Isolated Pi user extension directory, not a SuperBaodan factory injection.
  await temp.write("agent/extensions/shell-output-guard/index.js", await readFile(new URL("../extras/pi-extensions/shell-output-guard/index.js", import.meta.url), "utf8"));
  await temp.write("agent/extensions/check.ts", `
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export default function(pi) {
  pi.on('session_start', (_e, ctx) => appendFileSync(join(ctx.cwd, 'lifecycle.log'), 'start\\n'));
  pi.on('session_shutdown', (_e, ctx) => appendFileSync(join(ctx.cwd, 'lifecycle.log'), 'shutdown\\n'));
  pi.registerCommand('sdk-new', { handler: async (_args, ctx) => { await ctx.newSession(); } });
  pi.registerCommand('sdk-check', {
    handler: async (_args, ctx) => {
      const yes = await ctx.ui.confirm('confirm', 'continue?');
      const choice = await ctx.ui.select('select', ['A', 'B']);
      const text = await ctx.ui.input('input');
      const edit = await ctx.ui.editor('editor', 'prefill');
      if (!yes || choice !== 'A' || text !== 'ok' || edit !== 'edited') throw new Error('UI mismatch');
      pi.setSessionName('SDK验收');
      ctx.ui.notify('SDK UI ready', 'info');
    }
  });
}
`);
  const runtime = new PiSdkRuntime({ cwd: temp.resolve("workspace"), agentDir: temp.resolve("agent"), sessionDir: temp.resolve("sessions"), idleTimeoutMs: 600000, stopTimeoutMs: 5000 });
  const events = [];
  runtime.on("event", (event) => {
    events.push(event);
    if (event.type !== "extension_ui_request") return;
    const value = { select: "A", input: "ok", editor: "edited" }[event.method];
    if (event.method === "confirm" || value) void runtime.send({ type: "extension_ui_response", id: event.id, confirmed: true, value });
  });
  try {
    await runtime.ensureStarted();
    const sameSession = runtime.host.session;
    const applied = await runtime.updateProjectPrompt(async () => { await temp.write('workspace/AGENTS.md', 'PROJECT_PROMPT_LIVE_MARKER：按项目规范协作。'); return { revision: 'fixture' }; });
    assert.equal(applied.applied, true);
    assert.equal(runtime.host.session, sameSession);
    assert.ok(runtime.host.session.agent.state.systemPrompt.includes('PROJECT_PROMPT_LIVE_MARKER'));
    const commands = await runtime.send({ type: "get_commands" });
    assert.ok(commands.commands.some((item) => item.name === "sdk-check"));
    await runtime.send({ type: "set_model", provider: "fixture", modelId: "fixture" });
    await runtime.send({ type: "set_thinking_level", level: "off" });
    assert.ok((await runtime.send({ type: "get_available_thinking_levels" })).levels.includes("off"));
    await runtime.send({ type: "prompt", message: "/sdk-check" });
    assert.equal((await runtime.send({ type: "get_state" })).sessionName, "SDK验收");
    const tools = runtime.host.session.agent.state.tools;
    const read = tools.find((item) => item.name === "read");
    assert.ok(read);
    const readResult = await read.execute("test-read", { path: "input.txt" });
    assert.ok(readResult.content.some((item) => item.text?.includes("SDK中文文件读取")));
    const powershell = tools.find((item) => item.name === "powershell");
    assert.ok(powershell);
    const blockedBash = await runtime.send({ type: "bash", command: "where magick 2>nul" });
    assert.equal(blockedBash.cancelled, true);
    assert.match(blockedBash.output, /已阻止命令/);
    const shellResult = await powershell.execute("test-shell", { command: "Write-Output 'SDK中文输出'" });
    assert.ok(shellResult.content.some((item) => item.text?.includes("SDK中文输出")));
    await runtime.send({ type: "prompt", message: "读取input.txt并回答" });
    assert.equal(runtime.isBusy(), true);
    for (let attempt = 0; runtime.isBusy(); attempt += 1) {
      if (attempt > 1000) throw new Error("本地模型回合未结束");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(modelRequests, 2);
    assert.equal(sawProjectPrompt, true);
    const messages = (await runtime.send({ type: "get_messages" })).messages;
    assert.ok(messages.some((item) => item.role === "toolResult"));
    const blocked = messages.find((item) => item.role === "toolResult" && item.toolCallId === "fixture-nul");
    assert.equal(blocked?.isError, true);
    assert.match(blocked.content.map((part) => part.text || "").join(""), /已阻止命令/);
    assert.equal((await readdir(temp.resolve("workspace"))).some((name) => name.toLowerCase() === "nul"), false);
    assert.match((await runtime.send({ type: "get_last_assistant_text" })).text, /已读取SDK中文文件/);
    assert.ok(events.some((event) => event.type === "tool_execution_start" && event.toolName === "read"));
    assert.ok(events.some((event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"));
    assert.ok(events.filter((event) => event.type === "message_update").every((event) => !("partial" in event.assistantMessageEvent)));
    const first = await runtime.send({ type: "get_state" });
    const saved = await runtime.listSessions();
    assert.equal(saved.length, 1);
    await runtime.stop("idle");
    assert.equal(runtime.state, "idle");
    await runtime.ensureStarted();
    assert.equal((await runtime.send({ type: "get_state" })).sessionId, first.sessionId);
    assert.equal((await runtime.send({ type: "get_state" })).sessionName, "SDK验收");
    assert.equal((await runtime.send({ type: "get_messages" })).messages.length, messages.length);
    await runtime.newSession();
    const fresh = (await runtime.send({ type: "get_state" })).sessionId;
    assert.notEqual(fresh, first.sessionId);
    await runtime.send({ type: "prompt", message: "/sdk-new" });
    assert.notEqual((await runtime.send({ type: "get_state" })).sessionId, fresh);
    const hostBeforeSwitch = runtime.host;
    const eventOffset = events.length;
    const resumed = await runtime.openSession(first.sessionFile);
    assert.equal(resumed.sessionId, first.sessionId);
    assert.equal(runtime.host, hostBeforeSwitch);
    assert.equal((await runtime.send({ type: "get_messages" })).messages.length, messages.length);
    assert.ok((await runtime.send({ type: "get_commands" })).commands.some((item) => item.name === "sdk-check"));
    assert.equal(events.slice(eventOffset).some((item) => ["runtime_stopping", "runtime_stopped", "runtime_exit"].includes(item.type)), false);
    const repeatOffset = events.length;
    await runtime.openSession(first.sessionFile);
    assert.equal(events.length, repeatOffset);
    await runtime.close();
    const lifecycle = await readFile(temp.resolve("workspace", "lifecycle.log"), "utf8");
    // Project-prompt reload adds one shutdown/start pair without replacing the session.
    assert.equal(lifecycle.split("start\n").length - 1, 6);
    assert.equal(lifecycle.split("shutdown\n").length - 1, 6);
    assert.equal(runtime.host, null);
    assert.ok(events.some((event) => event.method === "notify"));
  } finally {
    await runtime.close();
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
    if (oldOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = oldOffline;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await temp.cleanup();
  }
});
