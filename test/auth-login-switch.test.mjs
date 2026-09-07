import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PiAdmin } from "../lib/pi-admin.mjs";

const runtimeContextSource = await readFile(new URL("../server/runtime-context.mjs", import.meta.url), "utf8");
const adminSource = await readFile(new URL("../lib/pi-admin.mjs", import.meta.url), "utf8");

test("取消旧OAuth登录会中止请求、解除输入等待并等待维护结束", async () => {
  const admin = new PiAdmin({ agentDir: "C:\\agent", cwd: "C:\\work", piRuntime: null, log: console });
  const abort = new AbortController();
  admin.activeLogins.set("anthropic", abort);
  let rejectInput;
  const pendingInput = new Promise((_, reject) => { rejectInput = reject; });
  pendingInput.catch(() => {});
  const timer = setTimeout(() => {}, 30_000);
  timer.unref?.();
  admin.loginInputs.set("anthropic-token", { providerId: "anthropic", reject: rejectInput, timer });
  let releaseMaintenance;
  admin.maintenanceActive = true;
  admin.maintenanceTail = new Promise((resolve) => { releaseMaintenance = resolve; });

  let completed = false;
  const cancelling = admin.cancelOAuthLogins().then((result) => { completed = true; return result; });
  await Promise.resolve();
  assert.equal(abort.signal.aborted, true);
  assert.equal(admin.loginInputs.size, 0);
  assert.equal(completed, false);
  releaseMaintenance();
  assert.equal(await cancelling, true);
});

test("新登录流先停止旧登录，且只有最后一次点击可以启动", () => {
  assert.match(runtimeContextSource, /const previousAbort = this\.activeAuthLoginAbort/);
  assert.match(runtimeContextSource, /previousAbort\?\.abort\(new Error\("已切换到其他供应商登录"\)\)/);
  assert.match(runtimeContextSource, /await this\.piAdmin\.cancelOAuthLogins\(\)/);
  assert.match(runtimeContextSource, /abort\.signal\.aborted \|\| sequence !== this\.authLoginSequence/);
  assert.match(runtimeContextSource, /await this\.piAdmin\.loginOAuth\(providerId/);
  assert.match(adminSource, /this\.cancelLoginInputs\(providerId, error\)/);
  assert.match(adminSource, /this\.activeLogins = new Map\(\)/);
});
