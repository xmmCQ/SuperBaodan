import { assertLocalRequest, assertSecureJsonMutation, json, readJsonBody } from "../response.mjs";

export function registerSkillRoutes(router) {
  router.get("/api/skills", async (req, res, _url, _match, context) => {
    assertLocalRequest(req, context.config); json(res, 200, await context.skillManager.list());
  });
  router.get("/api/skills/search", async (req, res, url, _match, context) => {
    assertLocalRequest(req, context.config); json(res, 200, await context.skillManager.search(url.searchParams.get("q") || ""));
  });
  for (const [path, action] of [
    ["/api/skills/install", "install"], ["/api/skills/check-updates", "checkUpdates"],
    ["/api/skills/update", "update"], ["/api/skills/uninstall", "uninstall"],
  ]) router.post(path, mutation(action));
  router.patch("/api/skills/invocation", mutation("setInvocation"));
  router.post("/api/skills/custom", mutation("createCustom"));
  router.put("/api/skills/custom", mutation("updateCustom"));
  router.delete("/api/skills/custom", mutation("deleteCustom"));

  router.get("/api/vskills", async (req, res, _url, _match, context) => {
    assertLocalRequest(req, context.config); json(res, 200, { vskills: await context.vskillManager.list() });
  });
  router.post("/api/vskills", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config); json(res, 201, { ok: true, vskill: await context.vskillManager.create(await readJsonBody(req)) });
  });
  router.put(/^\/api\/vskills\/([^/]+)$/, async (req, res, _url, match, context) => {
    assertSecureJsonMutation(req, context.config); json(res, 200, { ok: true, vskill: await context.vskillManager.update(decodeURIComponent(match[1]), await readJsonBody(req)) });
  });
  router.delete(/^\/api\/vskills\/([^/]+)$/, async (req, res, _url, match, context) => {
    assertSecureJsonMutation(req, context.config); await readJsonBody(req); json(res, 200, { ok: true, deleted: await context.vskillManager.delete(decodeURIComponent(match[1])) });
  });
}

function mutation(action) {
  return async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    const result = await context.skillManager[action](await readJsonBody(req));
    json(res, 200, action === "checkUpdates" ? result : { ok: true, ...result });
  };
}
