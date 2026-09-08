import test from "node:test";
import assert from "node:assert/strict";
import { sdkHarness, deferred, wait } from "./helpers/fake-sdk-host.mjs";

async function saved(h) {
  return h.temp.write("sessions/history.jsonl", `${JSON.stringify({ type: "session", id: "history", cwd: h.runtime.cwd })}\n`);
}

test("历史切换复用host、重绑事件，不走停止启动；重复选择不切换", async () => {
  const h = await sdkHarness();
  try {
    const file = await saved(h);
    await h.runtime.start();
    const host = h.runtime.host;
    let switches = 0;
    host.switchSession = async (target) => {
      switches += 1;
      host.beforeInvalidate();
      host.session = { ...host.session, sessionFile: target, sessionId: "history" };
      await host.rebind();
      return { cancelled: false };
    };
    const offset = h.events.length;
    assert.equal((await h.runtime.openSession(file)).sessionId, "history");
    await h.runtime.openSession(file);
    assert.equal(h.runtime.host, host);
    assert.equal(h.hosts.length, 1);
    assert.equal(switches, 1);
    assert.equal(h.events.slice(offset).some((e) => /runtime_stop/.test(e.type)), false);
    host.push({ type: "message_start", message: { role: "assistant" } });
    assert.equal(h.events.filter((e) => e.type === "message_start").length, 1);
  } finally { await h.cleanup(); }
});

test("扩展取消切换保留原会话；切换中拒绝普通命令", async () => {
  const h = await sdkHarness();
  const gate = deferred();
  try {
    const file = await saved(h);
    await h.runtime.start();
    const host = h.runtime.host, original = h.runtime.activeSessionPath;
    host.switchSession = async () => { await gate.promise; return { cancelled: true }; };
    const switching = h.runtime.openSession(file);
    while (!h.runtime.transitionCount) await wait(1);
    await assert.rejects(h.runtime.send({ type: "prompt", message: "blocked" }), /切换或关闭/);
    gate.resolve();
    await assert.rejects(switching, /已被扩展取消/);
    assert.equal(h.runtime.host, host);
    assert.equal(h.runtime.activeSessionPath, original);
    assert.equal(h.runtime.state, "running");
  } finally { gate.resolve(); await h.cleanup(); }
});

test("切换失败可恢复原会话；休眠后选择历史仍能初始化", async () => {
  const h = await sdkHarness();
  try {
    const file = await saved(h);
    await h.runtime.start();
    h.runtime.host.switchSession = async () => { throw new Error("switch failed"); };
    await assert.rejects(h.runtime.openSession(file), /switch failed/);
    assert.equal(h.runtime.host, null);
    await h.runtime.ensureStarted();
    assert.equal(h.hosts.length, 2);
    await h.runtime.stop("idle");
    await h.runtime.openSession(file);
    assert.equal(h.hosts.length, 3);
    assert.equal(h.runtime.activeSessionPath, file);
  } finally { await h.cleanup(); }
});
