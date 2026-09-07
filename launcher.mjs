import { closeSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const SERVER_FILE = path.join(ROOT, "server.mjs");
const SERVER_LOG = path.join(DATA_DIR, "server.log");
const SERVER_ERROR_LOG = path.join(DATA_DIR, "server-error.log");
const HOST = "127.0.0.1";
const PORT = Number(process.env.SUPER_BAODAN_PORT || 3211);
const URL = `http://${HOST}:${PORT}`;
const HEALTH_URL = `${URL}/api/health`;

await launch();

async function launch() {
  if (!await isHealthy()) {
    startServer();
    const ready = await waitUntilHealthy();
    if (!ready) {
      console.error(`超级宝蛋启动失败，请查看：${SERVER_ERROR_LOG}`);
      process.exitCode = 1;
      return;
    }
  }
  openBrowser(URL);
}

async function isHealthy(timeoutMs = 1_500) {
  try {
    const response = await fetch(HEALTH_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function startServer() {
  mkdirSync(DATA_DIR, { recursive: true });
  const stdout = openSync(SERVER_LOG, "a");
  const stderr = openSync(SERVER_ERROR_LOG, "a");
  try {
    const child = spawn(process.execPath, [SERVER_FILE], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
      env: process.env,
    });
    child.unref();
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

async function waitUntilHealthy() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await isHealthy()) return true;
  }
  return false;
}

function openBrowser(url) {
  if (process.platform === "win32") {
    const opener = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", "start", "", url], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    opener.unref();
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const opener = spawn(command, [url], { stdio: "ignore", detached: true });
  opener.unref();
}
