import path from "node:path";
import { readFile } from "node:fs/promises";
import { mutationError } from "../lib/task-writer.mjs";

export function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

export function assertLocalRequest(req, { host, port }) {
  const remote = req.socket?.remoteAddress || "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) throw mutationError(403, "仅允许本机访问");
  const expected = `${host}:${port}`;
  const requestHost = String(req.headers.host || "").toLowerCase();
  if (![expected, `localhost:${port}`].includes(requestHost)) throw mutationError(403, "请求主机无效");
  const origin = req.headers.origin;
  if (!origin) return;
  let originUrl;
  try { originUrl = new URL(origin); } catch { throw mutationError(403, "请求来源无效"); }
  if (![host, "localhost"].includes(originUrl.hostname) || Number(originUrl.port || 80) !== port) throw mutationError(403, "拒绝跨站请求");
}

export function assertSecureJsonMutation(req, config) {
  assertLocalRequest(req, config);
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw mutationError(415, "Content-Type必须是 application/json");
}

export function assertSecureBinaryMutation(req, config) {
  assertLocalRequest(req, config);
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/octet-stream")) throw mutationError(415, "上传文件必须使用 application/octet-stream");
}

export async function readBinaryBody(req, maxBytes) {
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw mutationError(413, `单个文件不能超过${maxBytes / 1024 / 1024}MB`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw mutationError(413, `单个文件不能超过${maxBytes / 1024 / 1024}MB`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw mutationError(413, "请求内容过大");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { throw mutationError(400, "请求 JSON 格式错误"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw mutationError(400, "请求 JSON 必须是对象");
  return body;
}

export function publicErrorMessage(error) {
  return String(error?.message || "服务器错误")
    .replace(/\b(?:sk|rt)\.[A-Za-z0-9._-]{12,}\b/gi, "[凭据已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, "[凭据已隐藏]")
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~-]{12,}/gi, "Bearer [凭据已隐藏]");
}

export async function serveStatic(publicDir, requestPath, res) {
  let relative;
  try { relative = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.replace(/^\//, "")); }
  catch { throw mutationError(400, "请求路径格式错误"); }
  const filePath = path.resolve(publicDir, relative);
  const relativePath = path.relative(publicDir, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return json(res, 403, { error: "禁止访问" });
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeType(filePath),
      "Cache-Control": [".html", ".js", ".mjs", ".css"].includes(path.extname(filePath)) ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(content);
  } catch (error) {
    if (error.code === "ENOENT") return json(res, 404, { error: "页面不存在" });
    throw error;
  }
}

function mimeType(filePath) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  })[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}
