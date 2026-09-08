export class ApiError extends Error {
  constructor(message, { status = 0, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ApiError";
    this.status = status;
    this.statusCode = status;
  }
}

export async function api(path, options = {}) {
  const {
    timeout = ["GET", "HEAD"].includes((options.method || "GET").toUpperCase()) ? 15000 : 0,
    signal,
    headers: incomingHeaders,
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  const headers = new Headers(incomingHeaders || {});
  if (typeof fetchOptions.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let timer = null;
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (Number.isFinite(timeout) && timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("请求超时"));
    }, timeout);
  }

  try {
    const response = await fetch(path, { ...fetchOptions, headers, signal: controller.signal });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch (cause) { throw new ApiError("服务返回了无法解析的数据", { status: response.status, cause }); }
    }
    if (!response.ok) {
      throw new ApiError(data?.error || `请求失败：${response.status}`, { status: response.status });
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) throw new ApiError("请求超时", { cause: error });
    if (controller.signal.aborted) throw new ApiError("请求已取消", { cause: error });
    throw new ApiError(error?.message || "服务连接失败", { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function workspaceUrl(path, workspaceId) {
  if (!workspaceId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}workspaceId=${encodeURIComponent(workspaceId)}`;
}

export function workspacePayload(payload = {}, workspaceId) {
  return { ...payload, ...(workspaceId ? { workspaceId } : {}) };
}
