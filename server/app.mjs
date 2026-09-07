import http from "node:http";
import { createRouter } from "./router.mjs";
import { json, publicErrorMessage, serveStatic } from "./response.mjs";
import { registerAgentRoutes } from "./routes/agent.mjs";
import { registerAuthRoutes } from "./routes/auth.mjs";
import { registerDailyRecordRoutes } from "./routes/daily-records.mjs";
import { registerModelRoutes } from "./routes/models.mjs";
import { registerSessionRoutes } from "./routes/sessions.mjs";
import { registerSkillRoutes } from "./routes/skills.mjs";
import { registerSystemRoutes } from "./routes/system.mjs";
import { registerTaskRoutes } from "./routes/tasks.mjs";
import { registerWorkspaceRoutes } from "./routes/workspaces.mjs";

export function createServerApplication(context) {
  const router = createRouter();
  registerSystemRoutes(router);
  registerAgentRoutes(router);
  registerAuthRoutes(router);
  registerDailyRecordRoutes(router);
  registerModelRoutes(router);
  registerSkillRoutes(router);
  registerWorkspaceRoutes(router);
  registerSessionRoutes(router);
  registerTaskRoutes(router);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${context.config.host}:${context.config.port}`}`);
      if (context.shuttingDown && url.pathname !== "/api/system/shutdown") return json(res, 503, { error: "工作台正在退出" });
      const switchAllowed = ["/api/health", "/api/agent/events"].includes(url.pathname) || /^\/api\/workspaces\/[^/]+\/activate$/.test(url.pathname);
      if (context.workspaceSwitching && !switchAllowed) return json(res, 409, { error: "工作区正在切换，请稍后重试" });
      if (await router.dispatch(req, res, url, context)) return;
      if (req.method === "GET") return serveStatic(context.config.publicDir, url.pathname, res);
      json(res, 404, { error: "接口不存在" });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      const message = publicErrorMessage(error);
      if (status >= 500) console.error(`[server] ${message}`);
      if (!res.headersSent) return json(res, status, { error: message });
      res.end();
    }
  });
  context.attachServer(server);
  return server;
}
