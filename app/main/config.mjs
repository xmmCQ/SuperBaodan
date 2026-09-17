import { existsSync } from "node:fs";
import path from "node:path";

const MANAGED_ENV_KEYS = [
  "SUPER_BAODAN_PORT", "SUPER_BAODAN_DATA_DIR", "SUPER_BAODAN_BACKUP_DIR",
  "SUPER_BAODAN_WORKSPACE", "SUPER_BAODAN_TODO_FILE", "SUPER_BAODAN_SESSION_DIR",
  "SUPER_BAODAN_VSKILL_FILE", "SUPER_BAODAN_DAILY_RECORD_FILE",
  "SUPER_BAODAN_WORKSPACE_FILE", "SUPER_BAODAN_DESKTOP_INSTANCE_ID",
  "SUPER_BAODAN_DESKTOP_OWNER_ID", "SUPER_BAODAN_DESKTOP_RUN_ID",
  "SUPER_BAODAN_DESKTOP_CONTROLLED", "ELECTRON_RUN_AS_NODE",
];

export function resolveDesktopConfig({ app, root, env = process.env }) {
  const packaged = Boolean(app.isPackaged);
  const localAppData = env.LOCALAPPDATA || app.getPath("appData");
  if (!path.isAbsolute(localAppData)) throw new Error("LOCALAPPDATA 路径无效");
  const productRoot = path.join(localAppData, "SuperBaodan");
  const desktopRoot = packaged ? path.join(productRoot, "desktop") : path.join(productRoot, "desktop-dev");
  const dataRoot = packaged ? productRoot : path.join(desktopRoot, "runtime");
  const nodePath = env.SUPER_BAODAN_NODE_PATH || process.execPath;
  if (!path.isAbsolute(nodePath)) throw new Error("Node.js 路径必须是绝对路径");
  if (env.SUPER_BAODAN_NODE_PATH && !existsSync(nodePath)) throw new Error(`找不到 Node.js：${nodePath}`);
  const useExistingConfig = !packaged && env.SUPER_BAODAN_DESKTOP_USE_EXISTING_CONFIG === "1";
  return {
    packaged,
    root,
    desktopRoot,
    userDataDir: desktopRoot,
    dataRoot,
    nodePath,
    piAgentDir: useExistingConfig && env.PI_CODING_AGENT_DIR
      ? path.resolve(env.PI_CODING_AGENT_DIR)
      : path.join(dataRoot, "pi-agent"),
  };
}

export function createBackendEnvironment(config, runId, source = process.env) {
  const env = { ...source };
  for (const key of MANAGED_ENV_KEYS) delete env[key];
  Object.assign(env, {
    SUPER_BAODAN_DATA_DIR: config.dataRoot,
    SUPER_BAODAN_BACKUP_DIR: path.join(config.dataRoot, "backups"),
    SUPER_BAODAN_WORKSPACE: path.join(config.dataRoot, "workspace"),
    SUPER_BAODAN_TODO_FILE: path.join(config.dataRoot, "work-todo.md"),
    SUPER_BAODAN_SESSION_DIR: path.join(config.dataRoot, "sessions"),
    SUPER_BAODAN_VSKILL_FILE: path.join(config.dataRoot, "vskills.json"),
    SUPER_BAODAN_DAILY_RECORD_FILE: path.join(config.dataRoot, "daily-records.json"),
    SUPER_BAODAN_WORKSPACE_FILE: path.join(config.dataRoot, "workspaces.json"),
    SUPER_BAODAN_DESKTOP_INSTANCE_ID: runId,
    SUPER_BAODAN_DESKTOP_RUN_ID: runId,
    SUPER_BAODAN_DESKTOP_CONTROLLED: "1",
    PI_CODING_AGENT_DIR: config.piAgentDir,
  });
  if (config.nodePath === process.execPath) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

