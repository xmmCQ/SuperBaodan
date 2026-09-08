import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServerApplication } from "./server/app.mjs";
import { createRuntimeContext } from "./server/runtime-context.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, "data");
const userHome = process.env.USERPROFILE || "C:\\Users\\niuli2288";
const config = {
  root,
  publicDir: path.join(root, "public"),
  holidayCacheDir: path.join(dataDir, 'holiday-cache'),
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
};

const context = await createRuntimeContext(config);
const server = createServerApplication(context);
server.listen(config.port, config.host, () => console.log(`超级宝蛋：http://${config.host}:${config.port}`));
process.on("SIGINT", () => void context.shutdown());
process.on("SIGTERM", () => void context.shutdown());
