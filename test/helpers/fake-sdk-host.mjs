import { EventEmitter } from "node:events";
import path from "node:path";
import { createTempProject } from "./temp-project.mjs";
import { PiSdkRuntime } from "../../lib/pi-sdk.mjs";

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function sdkHarness(options = {}) {
  const temp = await createTempProject("super-baodan-sdk-");
  const hosts = [], events = [], order = [];
  let nextId = 1;
  const createHost = async (args) => {
    await options.beforeCreate?.(args);
    const bus = new EventEmitter();
    const id = args.sessionManager?.id || `session-${nextId++}`;
    const file = args.sessionPath || args.sessionManager?.file || path.join(args.sessionDir, `${id}.jsonl`);
    const model = { id: "test", provider: "fake", name: "Test" };
    const session = {
      sessionFile: file, sessionId: id, sessionName: "", messages: [], model,
      thinkingLevel: "off", isStreaming: false, isCompacting: false, isBashRunning: false,
      promptTemplates: [{ name: "template", description: "Test" }], pendingMessageCount: 0,
      sessionManager: args.sessionManager || { file, id, getCwd: () => args.cwd },
      settingsManager: { flush: async () => { order.push("flush"); } },
      modelRuntime: { getAvailableSnapshot: () => [model] },
      resourceLoader: { getSkills: () => ({ skills: [{ name: "test-skill" }] }) },
      extensionRunner: { getRegisteredCommands: () => [{ invocationName: "ext:1" }], emitUserBash: async () => undefined },
      getAvailableThinkingLevels: () => ["off", "low"],
      setThinkingLevel(value) { this.thinkingLevel = value; },
      async setModel(value) { this.model = value; },
      setSessionName(value) { this.sessionName = value; },
      subscribe(fn) { bus.on("event", fn); return () => bus.off("event", fn); },
      async bindExtensions(bindings) { this.bindings = bindings; await options.bind?.(session, bindings); },
      prompt(message, config) { return options.prompt ? options.prompt(session, message, config) : Promise.resolve().then(() => config.preflightResult(true)); },
      async abort() { order.push("abort"); this.isStreaming = false; options.onAbort?.(); await options.abortGate?.promise; },
      abortCompaction() { this.isCompacting = false; }, abortBash() { this.isBashRunning = false; }, abortRetry() {},
      clearQueue() { return { steering: [], followUp: [] }; },
      getSessionStats: () => ({ messages: 0 }), getLastAssistantText: () => "test",
      setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
      executeBash: async () => ({ output: "中文", exitCode: 0 }), recordBashResult() {},
      waitForIdle: async () => {}, reload: async () => {},
      dispose() { order.push("dispose"); this.disposed = true; bus.removeAllListeners(); },
    };
    const host = {
      session, args,
      setBeforeSessionInvalidate(fn) { this.beforeInvalidate = fn; },
      setRebindSession(fn) { this.rebind = fn; },
      async dispose() { order.push("shutdown"); await options.disposeGate?.promise; session.dispose(); },
      push(event) { bus.emit("event", event); },
    };
    hosts.push(host);
    return { host, theme: {} };
  };
  const runtime = new PiSdkRuntime({
    cwd: temp.resolve("workspace"), agentDir: temp.resolve("agent"), sessionDir: temp.resolve("sessions"),
    createHost, idleTimeoutMs: options.idleTimeoutMs ?? 5000, stopTimeoutMs: options.stopTimeoutMs ?? 500,
    renameSaved: async (file, dir, name) => { order.push(["rename", file, name]); },
    log: { warn() {}, error() {} },
  });
  runtime.on("event", (event) => events.push(event));
  return {
    runtime, temp, hosts, events, order,
    async cleanup() {
      options.abortGate?.resolve(); options.disposeGate?.resolve(); options.onAbort?.();
      await runtime.close(); await temp.cleanup();
    },
  };
}
