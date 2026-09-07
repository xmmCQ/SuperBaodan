import { assertLocalRequest, assertSecureJsonMutation, json, readJsonBody } from "../response.mjs";

export function registerModelRoutes(router) {
  router.get("/api/models/config", async (req, res, _url, _match, context) => {
    assertLocalRequest(req, context.config);
    json(res, 200, await context.piAdmin.readModelsConfig());
  });
  router.put("/api/models/config", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    json(res, 200, { ok: true, ...(await context.piAdmin.saveModelsConfig(await readJsonBody(req))) });
  });
  router.post("/api/models/test", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    json(res, 200, await context.piAdmin.testModel(await readJsonBody(req)));
  });
  router.get("/api/models/catalog", async (req, res, _url, _match, context) => {
    assertLocalRequest(req, context.config);
    json(res, 200, await context.piAdmin.catalog());
  });
  router.put("/api/models/preferences", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    json(res, 200, { ok: true, ...(await context.piAdmin.savePreferences(await readJsonBody(req))) });
  });
}
