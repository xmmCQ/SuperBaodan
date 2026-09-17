export function createBootstrapLoader({ client, getWorkspaceId, apply, onError }) {
  let sequence = 0;
  return async function loadBootstrap() {
    const request = ++sequence, workspaceId = getWorkspaceId();
    let data;
    const current = () => request === sequence && (!workspaceId || workspaceId === getWorkspaceId()) && (!data || client.bootstrapCurrent?.(data) !== false);
    try {
      data = await client.bootstrap();
      if (current()) await apply(data, current);
    } catch (error) { if (!error.staleResponse && current()) onError(error); }
  };
}
