import { assertLocalRequest, assertSecureJsonMutation, json, readJsonBody } from "../response.mjs";

export function registerDailyRecordRoutes(router) {
  router.get("/api/daily-records", async (req, res, url, _match, context) => {
    assertLocalRequest(req, context.config);
    json(res, 200, { records: await context.dailyRecordManager.listByDate(url.searchParams.get("date")) });
  });

  router.get("/api/daily-records/summary", async (req, res, url, _match, context) => {
    assertLocalRequest(req, context.config);
    json(res, 200, { dates: await context.dailyRecordManager.monthSummary(url.searchParams.get("month")) });
  });

  router.get("/api/daily-records/search", async (req, res, url, _match, context) => {
    assertLocalRequest(req, context.config);
    json(res, 200, await context.dailyRecordManager.search(url.searchParams.get("q")));
  });

  router.post("/api/daily-records", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    json(res, 201, { ok: true, record: await context.dailyRecordManager.create(await readJsonBody(req)) });
  });

  router.put(/^\/api\/daily-records\/([0-9a-f-]+)$/i, async (req, res, _url, match, context) => {
    assertSecureJsonMutation(req, context.config);
    json(res, 200, { ok: true, record: await context.dailyRecordManager.update(match[1], await readJsonBody(req)) });
  });

  router.delete(/^\/api\/daily-records\/([0-9a-f-]+)$/i, async (req, res, _url, match, context) => {
    assertSecureJsonMutation(req, context.config);
    const body = await readJsonBody(req);
    json(res, 200, { ok: true, deleted: await context.dailyRecordManager.delete(match[1], body.revision) });
  });
}
