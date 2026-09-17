export class ApplicationError extends Error {
  constructor(message, { status = 0, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ApplicationError'; this.status = status; this.statusCode = status;
  }
}

export async function invoke(name, args = {}, { signal, timeout = 120000 } = {}) {
  const bridge = window.workbench;
  if (!bridge) throw new ApplicationError('请从桌面应用打开工作台');
  if (signal?.aborted) throw new ApplicationError('操作已取消', { status: 499 });
  const id = crypto.randomUUID();
  let timer, abort;
  try {
    const cancelled = new Promise((_, reject) => {
      abort = () => { bridge.cancel(id); reject(new ApplicationError('操作已取消', { status: 499 })); };
      signal?.addEventListener('abort', abort, { once: true });
      if (timeout > 0) timer = setTimeout(() => { bridge.cancel(id); reject(new ApplicationError('操作超时', { status: 408 })); }, timeout);
    });
    const response = await Promise.race([bridge.invoke(id, name, args), cancelled]);
    if (!response.ok) throw new ApplicationError(response.error.message, { status: response.error.code });
    return response.value;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export function workspacePayload(payload = {}, workspaceId) {
  return { ...payload, ...(workspaceId ? { workspaceId } : {}) };
}

// Binary preview resources are scoped to a workspace, not exposed as file:// paths.
export function scopedResource(resource, workspaceId) {
  const url = new URL(resource);
  if (workspaceId) url.searchParams.set('workspaceId', workspaceId);
  return url.href;
}
