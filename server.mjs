import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServerApplication } from "./server/app.mjs";
import { createRuntimeContext } from "./server/runtime-context.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SUPER_BAODAN_DATA_DIR || path.join(root, "data");
const userHome = process.env.USERPROFILE || os.homedir();
const desktopRunId = process.env.SUPER_BAODAN_DESKTOP_RUN_ID || null;
const desktopControlled = process.env.SUPER_BAODAN_DESKTOP_CONTROLLED === "1" && Boolean(desktopRunId) && typeof process.send === "function";
let context = null;
let shutdownRequested = false;
let shutdownPromise = null;

if (desktopControlled) {
  process.on("message", (message) => {
    if (!message || typeof message !== "object" || message.type !== "shutdown" || message.runId !== desktopRunId) return;
    void shutdownDesktop("parent-request");
  });
  process.once("disconnect", () => {
    shutdownRequested = true;
    const fallback = setTimeout(() => process.exit(0), 5_000); fallback.unref();
    void shutdownDesktop("parent-disconnect");
  });
}

const config = {
  root,
  publicDir: path.join(root, "public"),
  holidayCacheDir: path.join(dataDir, "holiday-cache"),
  backupDir: process.env.SUPER_BAODAN_BACKUP_DIR || path.join(dataDir, "backups"),
  workspaceDir: process.env.SUPER_BAODAN_WORKSPACE || path.join(root, "workspace"),
  todoFile: process.env.SUPER_BAODAN_TODO_FILE || path.join(dataDir, "work-todo.md"),
  appScript: path.join(root, "scripts", "open-work-apps.ps1"),
  host: "127.0.0.1",
  port: Number(process.env.SUPER_BAODAN_PORT || 3211),
  piAgentDir: process.env.PI_CODING_AGENT_DIR || path.join(userHome, ".pi", "agent"),
  piSessionDir: process.env.SUPER_BAODAN_SESSION_DIR || path.join(dataDir, "sessions"),
  vskillFile: process.env.SUPER_BAODAN_VSKILL_FILE || path.join(dataDir, "vskills.json"),
  dailyRecordFile: process.env.SUPER_BAODAN_DAILY_RECORD_FILE || path.join(dataDir, "daily-records.json"),
  workspaceFile: process.env.SUPER_BAODAN_WORKSPACE_FILE || path.join(dataDir, "workspaces.json"),
  desktopInstanceId: desktopRunId,
  desktopControlled,
};

try {
  context = await createRuntimeContext(config);
  if (shutdownRequested) await shutdownDesktop("parent-disconnect");
  else {
    const server = createServerApplication(context);
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(config.port, config.host);
    });
    console.log(`超级宝蛋：http://${config.host}:${config.port}`);
    sendDesktop({ type: "ready", runId: desktopRunId });
  }
} catch (error) {
  sendDesktop({ type: "startup-error", runId: desktopRunId, message: String(error?.message || "后台服务启动失败") });
  console.error(`[startup] ${error?.message || error}`);
  if (context) await context.shutdown({ exitProcess: false }).catch(() => {});
  process.exitCode = 1;
}

process.on("SIGINT", () => void handleSignal());
process.on("SIGTERM", () => void handleSignal());

async function handleSignal() {
  if (desktopControlled) await shutdownDesktop("signal");
  else await context?.shutdown();
}

function shutdownDesktop(reason) {
  if (shutdownPromise) return shutdownPromise;
  shutdownRequested = true;
  shutdownPromise = (async () => {
    try {
      await context?.shutdown({ exitProcess: false });
      sendDesktop({ type: "shutdown-complete", runId: desktopRunId, reason });
      process.exit(0);
    } catch (error) {
      sendDesktop({ type: "shutdown-error", runId: desktopRunId, message: String(error?.message || "后台服务关闭失败") });
      throw error;
    }
  })();
  return shutdownPromise;
}

function sendDesktop(message) {
  if (!desktopControlled || !process.connected) return;
  try { process.send(message); } catch {}
}
