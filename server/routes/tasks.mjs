import { json, readJsonBody } from "../response.mjs";

export function registerTaskRoutes(router) {
  router.get("/api/dashboard", async (_req, res, url, _match, context) => {
    const month = validMonth(url.searchParams.get("month")) || context.today().slice(0, 7);
    const { tasks, updatedAt, stale, warning } = await context.loadTasks();
    json(res, 200, { ...context.dashboard(tasks, month), updatedAt, stale, warning });
  });
  router.get(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/, async (_req, res, _url, match, context) => {
    const { tasks, updatedAt, stale, warning } = await context.loadTasks();
    json(res, 200, { date: match[1], tasks: context.dayDetails(tasks, match[1]), updatedAt, stale, warning });
  });
  router.post("/api/tasks", taskMutation("create", 201));
  router.patch(/^\/api\/tasks\/([a-f0-9]{12})\/move$/, taskMutation("move", 200));
  router.patch(/^\/api\/tasks\/([a-f0-9]{12})$/, taskMutation("update", 200));
  router.delete(/^\/api\/tasks\/([a-f0-9]{12})$/, taskMutation("delete", 200));
}

function taskMutation(kind, status) {
  return async (req, res, _url, match, context) => {
    const body = await readJsonBody(req);
    const result = await context.mutateTask(kind, body.revision, match?.[1], body);
    json(res, status, { ok: true, updatedAt: result.updatedAt });
  };
}

function validMonth(value) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "") ? value : null; }
