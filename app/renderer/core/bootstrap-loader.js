export function createBootstrapLoader({ client, getWorkspaceId, apply, onError, beforeLoad = () => {} }) {
  let sequence = 0;
  return async function loadBootstrap() {
    const request = ++sequence, workspaceId = getWorkspaceId();
    let data;
    const current = () => request === sequence && (!workspaceId || workspaceId === getWorkspaceId()) && (!data || client.bootstrapCurrent?.(data) !== false);
    try {
      beforeLoad();
      data = await client.bootstrap();
      if (current()) await apply(data, current);
    } catch (error) { if (!error.staleResponse && current()) onError(error); }
  };
}
