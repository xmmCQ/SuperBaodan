import { readFile } from "node:fs/promises";
import { captureWorkspace, withWorkspaceSnapshot } from '../workspace-operations.mjs';
import { readProjectPrompt } from '../../lib/project-prompt.mjs';
import { mutationError } from "../../lib/task-writer.mjs";
import { MAX_BINARY_PREVIEW_BYTES, MAX_UPLOAD_FILE_BYTES } from "../../lib/workspace.mjs";
import { assertLocalRequest, assertSecureBinaryMutation, assertSecureJsonMutation, json, readBinaryBody, readJsonBody } from "../response.mjs";

export function registerWorkspaceRoutes(router) {
  router.get('/api/workspace/project-prompt', async (req, res, url, _match, context) => {
    assertLocalRequest(req, context.config);
    const workspaceId = url.searchParams.get('workspaceId');
    if (!workspaceId) throw mutationError(400, '缺少项目标识');
    context.assertActiveWorkspace(workspaceId);
    const root = context.workspaceService.rootReal;
    json(res, 200, { ...await readProjectPrompt(root), workspaceId });
  });
  router.put('/api/workspace/project-prompt', async (req, res, _url, _match, context) => {
    assertSecureJsonMutation(req, context.config);
    json(res, 200, await context.saveProjectPrompt(await readJsonBody(req)));
  });
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
    const snapshot = captureWorkspace(context);
    const body = await readJsonBody(req);
    const result = await withWorkspaceSnapshot(context, snapshot, body.workspaceId, ({ files }) => files.checkUpload(body.directory || '', body.files));
    json(res, 200, result);
  });
  router.post("/api/workspace/upload", async (req, res, url, _match, context) => {
    assertSecureBinaryMutation(req, context.config);
    const workspaceId = url.searchParams.get('workspaceId');
    const snapshot = captureWorkspace(context, workspaceId);
    // Do not hold the workspace queue while receiving a potentially slow upload.
    const content = await readBinaryBody(req, MAX_UPLOAD_FILE_BYTES);
    const uploaded = await withWorkspaceSnapshot(context, snapshot, workspaceId, ({ files }) => files.upload(url.searchParams.get("directory") || "", url.searchParams.get("name") || "", content, { overwrite: url.searchParams.get("overwrite") === "true" }));
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
