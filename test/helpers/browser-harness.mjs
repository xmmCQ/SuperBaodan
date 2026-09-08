import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createTempProject } from "./temp-project.mjs";

const EDGE_CANDIDATES = process.platform === "win32"
  ? [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ]
  : [
      "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
    ];

export function edgeAvailable() {
  return EDGE_CANDIDATES.some(existsSync);
}

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function launchBrowser({ width, height } = {}) {
  const executable = EDGE_CANDIDATES.find(existsSync);
  if (!executable) throw new Error("未找到Microsoft Edge");
  const debugPort = await freePort();
  const profileParent = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA, "Temp")
    : "/mnt/c/Users/niuli2288/AppData/Local/Temp";
  const profile = await createTempProject("superbaodan-browser-test-", { baseDirectory: profileParent });
  const profilePath = profile.root;
  await rm(profilePath, { recursive: true, force: true });
  let stderr = "";
  const child = spawn(executable, [
    "--headless=new", "--disable-gpu", "--disable-background-mode", "--no-first-run", "--disable-extensions",
    ...(width && height ? [`--window-size=${Math.round(width)},${Math.round(height)}`] : []),
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${toWindowsPath(profilePath)}`,
    "about:blank",
  ], { cwd: process.platform === "win32" ? process.env.SystemDrive + "\\" : "/mnt/c", stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  let connection;
  try {
    const target = await waitForDebugger(debugPort);
    connection = await connectCdp(target.webSocketDebuggerUrl);
    await connection.command("Runtime.enable");
    await connection.command("Page.enable");
    await connection.command("Network.enable");
  } catch (error) {
    connection?.close();
    child.kill("SIGKILL");
    await stopEdgeForProfile(profilePath);
    await profile.cleanup();
    throw new Error(`${error.message}（端口${debugPort}，配置${profilePath}）${stderr.trim() ? `：${stderr.trim().slice(-300)}` : ""}`);
  }
  return {
    issues: connection.issues,
    addInitScript: (source) => connection.command("Page.addScriptToEvaluateOnNewDocument", { source }),
    async navigate(url) {
      connection.issues.length = 0;
      const before = connection.navigationVersion();
      const result = await connection.command("Page.navigate", { url });
      if (result.errorText) throw new Error(result.errorText);
      const deadline = Date.now() + 6000;
      while (connection.navigationVersion() === before) {
        if (Date.now() > deadline) throw new Error(`页面导航未提交：${url}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await connection.waitFor(`document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`);
    },
    evaluate: connection.evaluate,
    waitFor: connection.waitFor,
    async close() {
      await connection.command("Browser.close").catch(() => {});
      connection.close();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      if (!child.killed) child.kill();
      await profile.cleanup();
    },
  };
}

async function waitForDebugger(port) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      const page = targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Edge调试端口启动超时");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0, navigation = 0;
  const pending = new Map();
  const issues = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id);
      clearTimeout(operation.timer);
      if (message.error) operation.reject(new Error(message.error.message));
      else operation.resolve(message.result);
      return;
    }
    if ((message.method === "Page.frameNavigated" && !message.params.frame.parentId) || message.method === "Page.navigatedWithinDocument") navigation += 1;
    if (message.method === "Runtime.exceptionThrown") issues.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
      issues.push(message.params.args.map((item) => item.value || item.description || "").join(" "));
    }
    if (message.method === "Network.loadingFailed" && !message.params.canceled) issues.push(message.params.errorText);
  });

  socket.addEventListener("close", () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("浏览器调试连接已关闭")); }
    pending.clear();
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error("浏览器调试连接不可用")); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`浏览器命令超时：${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`等待页面状态超时：${expression}`);
  };
  return { command, evaluate, waitFor, issues, navigationVersion: () => navigation, close: () => socket.close() };
}

async function stopEdgeForProfile(profilePath) {
  const needle = toWindowsPath(profilePath).replaceAll("'", "''");
  const script = `$needle = '${needle}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like ('*' + $needle + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  await new Promise((resolve) => {
    const cleanup = spawn("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
    cleanup.once("error", resolve);
    cleanup.once("exit", resolve);
  });
}

function toWindowsPath(file) {
  const match = file.match(/^\/mnt\/([a-z])\/(.*)$/i);
  return match ? `${match[1].toUpperCase()}:\\${match[2].replaceAll("/", "\\")}` : file;
}
