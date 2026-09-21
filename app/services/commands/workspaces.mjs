import { fault } from "../../shared/errors.js";
import { readFile } from "node:fs/promises";
import { captureWorkspace, withWorkspaceSnapshot } from '../workspace-operations.mjs';
import { readProjectPrompt } from '../domain/project-prompt.mjs';

import { MAX_BINARY_PREVIEW_BYTES, MAX_UPLOAD_FILE_BYTES } from "../domain/workspace.mjs";

export function registerWorkspaceCommands(commands) {
  commands.set("projectPrompt.read", async (args, context) => {
    const workspaceId = args.workspaceId;
    if (!workspaceId) throw fault(400, '缺少项目标识');
    context.assertActiveWorkspace(workspaceId);
    const root = context.workspaceService.rootReal;
    return { ...await readProjectPrompt(root), workspaceId };
  });
  commands.set("projectPrompt.save", async (args, context) => {
    return await context.saveProjectPrompt(args);
  });
  commands.set("workspaces.list", async (args, context) => {
    return await context.publicWorkspaceList();
  });
  commands.set("workspaces.browse", async (args, context) => {
    return await context.workspaceRegistry.browse(args.path || "");
  });
  commands.set("workspaces.add", async (args, context) => {
    return { ok: true, workspace: context.publicWorkspace(await context.workspaceRegistry.add(args)) };
  });
  commands.set("workspaces.rename", async (args, context) => {
    const item = await context.workspaceRegistry.rename(args.id, (args).name);
    if (item.id === context.activeWorkspace.id) {
      context.activeWorkspace = item;
      context.emitAgentEvent({ type: "workspace_changed", workspace: context.publicWorkspace(item), renamed: true });
    }
    return { ok: true, workspace: context.publicWorkspace(item) };
  });
  commands.set("workspaces.remove", async (args, context) => {
    return { ok: true, ...(await context.workspaceRegistry.remove(args.id)) };
  });
  commands.set("workspaces.activate", async (args, context) => {
    return { ok: true, ...(await context.activateWorkspace(args.id)) };
  });

  commands.set("files.checkUpload", async (args, context) => {
    const snapshot = captureWorkspace(context);
    const body = args;
    const result = await withWorkspaceSnapshot(context, snapshot, body.workspaceId, ({ files }) => files.checkUpload(body.directory || '', body.files));
    return result;
  });
  commands.set("files.upload", async (args, context) => {
    const workspaceId = args.workspaceId;
    const snapshot = captureWorkspace(context, workspaceId);
    // Do not hold the workspace queue while receiving a potentially slow upload.
    const content = Buffer.from(args.content || []);
    if (content.length > MAX_UPLOAD_FILE_BYTES) throw fault(413, "文件过大");
    const uploaded = await withWorkspaceSnapshot(context, snapshot, workspaceId, ({ files }) => files.upload(args.directory || "", args.name || "", content, { overwrite: args.overwrite === true }));
    return { ok: true, uploaded };
  });
  commands.set("files.tree", async (args, context) => {
    context.assertActiveWorkspace(args.workspaceId);
    return await context.workspaceService.tree(args.path || "", args.depth);
  });
  commands.set("files.search", async (args, context) => {
    context.assertActiveWorkspace(args.workspaceId);
    return { results: await context.workspaceService.search(args.q || "") };
  });
  commands.set("files.preview", async (args, context) => {
    context.assertActiveWorkspace(args.workspaceId);
    return await context.workspaceService.preview(args.path || "");
  });
  commands.set("files.content", async (args, context) => {
    context.assertActiveWorkspace(args.workspaceId);
    const file = await context.workspaceService.content(args.path || "");
    const content = await readFile(file.absolute);
    if (content.length > MAX_BINARY_PREVIEW_BYTES) throw fault(413, "文件在读取期间超过预览大小限制");
    return { mime: file.mime, content };
  });
}
