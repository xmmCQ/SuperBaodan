import { assertLocalRequest, assertSecureJsonMutation, json, readJsonBody } from "../response.mjs";

export function registerAuthRoutes(router) {
  router.get("/api/auth/providers", async (req, res, _url, _match, context) => {
    assertLocalRequest(req, context.config);
    json(res, 200, await context.piAdmin.providers());
  });

  router.get(/^\/api\/auth\/login\/([^/]+)$/, (req, res, _url, match, context) => {
    assertLocalRequest(req, context.config);
    context.openAuthLoginStream(req, res, decodeURIComponent(match[1]));
  });

  router.post(/^\/api\/auth\/login\/([^/]+)\/input$/, async (req, res, _url, match, context) => {
    assertSecureJsonMutation(req, context.config);
    const body = await readJsonBody(req);
    context.piAdmin.submitLoginInput(decodeURIComponent(match[1]), body.token, body.value);
    json(res, 200, { ok: true });
  });

  router.post(/^\/api\/auth\/logout\/([^/]+)$/, async (req, res, _url, match, context) => {
    assertSecureJsonMutation(req, context.config);
    await readJsonBody(req);
    json(res, 200, { ok: true, ...(await context.piAdmin.logout(decodeURIComponent(match[1]), "oauth")) });
  });

  router.post(/^\/api\/auth\/api-key\/([^/]+)$/, async (req, res, _url, match, context) => {
    assertSecureJsonMutation(req, context.config);
    const body = await readJsonBody(req);
    json(res, 200, { ok: true, ...(await context.piAdmin.saveApiKey(decodeURIComponent(match[1]), body.apiKey)) });
  });

  router.delete(/^\/api\/auth\/api-key\/([^/]+)$/, async (req, res, _url, match, context) => {
    assertSecureJsonMutation(req, context.config);
    await readJsonBody(req);
    json(res, 200, { ok: true, ...(await context.piAdmin.logout(decodeURIComponent(match[1]), "api_key")) });
  });
}
