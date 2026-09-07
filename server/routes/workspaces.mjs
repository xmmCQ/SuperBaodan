import { readFile } from "node:fs/promises";
import { mutationError } from "../../lib/task-writer.mjs";
import { MAX_BINARY_PREVIEW_BYTES, MAX_UPLOAD_FILE_BYTES } from "../../lib/workspace.mjs";
import { assertLocalRequest, assertSecureBinaryMutation, assertSecureJsonMutation, json, readBinaryBody, readJsonBody } from "../response.mjs";

export function registerWorkspaceRoutes(router) {
  router.get("/api/workspaces", async (req, res, _url, _match, context) => {
    assertLocalRequest(req, context.config); json(res, 200, await context.publicWorkspaceList());
  });
  router.get("/api/workspaces/browse", async (req, res, url, _match, context) => {
    assertLocalRequest(req, context.config); json(res, 200, await context.workspaceRegistry.browse(url.searchParams.get("path") || ""));
  });
  router.post("/api/workspaces", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    json(res, 201, { ok: true, workspace: context.publicWorkspace(await context.workspaceRegistry.add(await readJsonBody(req))) });
  });
  router.put(/^\/api\/workspaces\/([^/]+)$/, async (req, res, _url, match, context) => {
    assertSecureJsonMutation(req, context.config);
    const item = await context.workspaceRegistry.rename(decodeURIComponent(match[1]), (await readJsonBody(req)).name);
    if (item.id === context.activeWorkspace.id) {
      context.activeWorkspace = item;
      context.emitAgentEvent({ type: "workspace_changed", workspace: context.publicWorkspace(item), renamed: true });
    }
    json(res, 200, { ok: true, workspace: context.publicWorkspace(item) });
  });
  router.delete(/^\/api\/workspaces\/([^/]+)$/, async (req, res, _url, match, context) => {
    assertSecureJsonMutation(req, context.config); await readJsonBody(req);
    json(res, 200, { ok: true, ...(await context.workspaceRegistry.remove(decodeURIComponent(match[1]))) });
  });
  router.post(/^\/api\/workspaces\/([^/]+)\/activate$/, async (req, res, _url, match, context) => {
    assertSecureJsonMutation(req, context.config); await readJsonBody(req);
    json(res, 200, { ok: true, ...(await context.activateWorkspace(decodeURIComponent(match[1]))) });
  });

  router.post("/api/workspace/upload/check", async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    const body = await readJsonBody(req); context.assertActiveWorkspace(body.workspaceId);
    json(res, 200, await context.workspaceService.checkUpload(body.directory || "", body.files));
  });
  router.post("/api/workspace/upload", async (req, res, url, _match, context) => {
    assertSecureBinaryMutation(req, context.config); context.assertActiveWorkspace(url.searchParams.get("workspaceId"));
    const content = await readBinaryBody(req, MAX_UPLOAD_FILE_BYTES);
    const uploaded = await context.workspaceService.upload(url.searchParams.get("directory") || "", url.searchParams.get("name") || "", content, { overwrite: url.searchParams.get("overwrite") === "true" });
    json(res, 201, { ok: true, uploaded });
  });
  router.get("/api/workspace/tree", async (req, res, url, _match, context) => {
    assertLocalRequest(req, context.config); context.assertActiveWorkspace(url.searchParams.get("workspaceId"));
    json(res, 200, await context.workspaceService.tree(url.searchParams.get("path") || "", url.searchParams.get("depth")));
  });
  router.get("/api/workspace/search", async (req, res, url, _match, context) => {
    assertLocalRequest(req, context.config); context.assertActiveWorkspace(url.searchParams.get("workspaceId"));
    json(res, 200, { results: await context.workspaceService.search(url.searchParams.get("q") || "") });
  });
  router.get("/api/workspace/preview", async (req, res, url, _match, context) => {
    assertLocalRequest(req, context.config); context.assertActiveWorkspace(url.searchParams.get("workspaceId"));
    json(res, 200, await context.workspaceService.preview(url.searchParams.get("path") || ""));
  });
  router.get("/api/workspace/content", async (req, res, url, _match, context) => {
    assertLocalRequest(req, context.config); context.assertActiveWorkspace(url.searchParams.get("workspaceId"));
    const file = await context.workspaceService.content(url.searchParams.get("path") || "");
    const content = await readFile(file.absolute);
    if (content.length > MAX_BINARY_PREVIEW_BYTES) throw mutationError(413, "文件在读取期间超过预览大小限制");
    res.writeHead(200, { "Content-Type": file.mime, "Content-Length": content.length, "Content-Disposition": "inline", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(content);
  });
}
