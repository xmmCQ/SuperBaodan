import test from "node:test";
import assert from "node:assert/strict";
import { createServerApplication } from "./helpers/command-http-fixture.mjs";
import { linkedContexts } from './helpers/linked-contexts.mjs';
import { sdkHarness, deferred } from "./helpers/fake-sdk-host.mjs";

async function createContext(h) {
  return linkedContexts({
    root: h.temp.root, publicDir: h.temp.root, host: "127.0.0.1", port: 0,
    workspaceDir: h.runtime.cwd, piAgentDir: h.runtime.agentDir, piSessionDir: h.runtime.sessionDir,
    backupDir: h.temp.resolve("backups"), todoFile: h.temp.resolve("todo.md"),
    vskillFile: h.temp.resolve("vskills.json"), dailyRecordFile: h.temp.resolve("records.json"), workspaceFile: h.temp.resolve("workspaces.json"),
  },{createRuntime:()=>h.runtime});
}

test("HTTP健康状态标记SDK，维护期间不唤醒Agent，切换期间仍能回复候选会话弹窗", async () => {
  const h = await sdkHarness();
  const {agent:context,local} = await createContext(h);
  const server = createServerApplication(local);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.config.port = server.address().port;
  const base = `http://127.0.0.1:${server.address().port}`;
  const command = (body) => fetch(`${base}/api/agent/command`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(`${base}/api/health`)).json()).runtime, "windows-node-sdk");
    context.piAdmin.maintenanceActive = true;
    assert.equal((await command({ type: "prompt", message: "blocked" })).status, 409);
    assert.equal((await fetch(`${base}/api/agent/bootstrap`)).status, 409);
    assert.equal(h.hosts.length, 0);
    context.piAdmin.maintenanceActive = false;
    await h.temp.write("sessions/search.jsonl", [
      { type: "session", id: "search", cwd: h.runtime.cwd },
      { type: "message", id: "entry-search", message: { role: "user", content: "正文命中" } },
    ].map((item) => JSON.stringify(item)).join("\n") + "\n");
    const search = await (await fetch(`${base}/api/sessions/search?q=${encodeURIComponent("正文")}`)).json();
    assert.equal(search.complete, true); assert.equal(search.hits[0].entryId, "entry-search");
    assert.equal((await fetch(`${base}/api/sessions/search?q=test&workspaceId=wrong`)).status, 409);
    await h.runtime.start();
    const snapshot = await (await fetch(`${base}/api/agent/snapshot`)).json();
    assert.equal(snapshot.messages, undefined);
    assert.ok(snapshot.messagesVersion);
    const full = await (await fetch(`${base}/api/agent/snapshot?messages=1`)).json();
    assert.deepEqual(full.messages, []);
    const unchanged = await (await fetch(`${base}/api/agent/snapshot?messages=1&since=${encodeURIComponent(full.messagesVersion)}`)).json();
    assert.equal(unchanged.messages, undefined);
    const requestId = "http-prompt-123456789";
    assert.equal((await command({ type: "prompt", message: "hello", requestId })).status, 200);
    assert.equal((await (await fetch(`${base}/api/agent/receipt?requestId=${requestId}`)).json()).status, "accepted");
    assert.equal((await command({ type: "prompt", message: "other", requestId })).status, 409);
    context.workspaceSwitching = true;
    const question = h.hosts[0].session.bindings.uiContext.confirm("候选工作区", "continue");
    const request = h.runtime.pendingUiRequests()[0];
    // IPC reconnect replays pending interactive requests before workspace commit.
    assert.ok(local.agentConnection().some(event => event.id === request.id));
    assert.equal((await command({ type: "prompt", message: "blocked" })).status, 409);
    assert.equal((await command({ type: "extension_ui_response", id: request.id, confirmed: true, workspaceId: "old-workspace" })).status, 200);
    assert.equal(await question, true);
  } finally {
    context.piAdmin.maintenanceActive = false;
    context.piAdmin.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await h.cleanup();
  }
});

test("工作区切换遇到SDK清理超时，不创建候选或回滚Agent", async () => {
  const gate = deferred();
  const h = await sdkHarness({ disposeGate: gate, stopTimeoutMs: 15 });
  const {agent:context,local} = await createContext(h);
  let creates = 0;
  context.makeServices = async () => { creates += 1; throw new Error("must not create"); };
  try {
    await h.runtime.start();
    const targetPath = await h.temp.ensureDir("second-workspace");
    const target = await local.workspaceRegistry.add({ path: targetPath, name: "第二工作区" });
    await assert.rejects(local.activateWorkspace(target.id), /未释放|退出|关闭|清理|超时/);
    assert.equal(creates, 0);
    assert.equal(local.workspaceSwitching, false);
    assert.equal(h.runtime.state, "error");
  } finally { gate.resolve(); context.piAdmin.close(); await h.cleanup(); }
});
