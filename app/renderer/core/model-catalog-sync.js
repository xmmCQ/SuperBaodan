// One reader per page/workspace; distribute the same result to all model UIs.
export function createModelCatalogSync({ scope, read, apply, onError, capture = () => () => true }) {
  let pending, sequence = 0;
  function receive(event) {
    const owner = scope();
    if (event.workspaceId && event.workspaceId !== owner) return Promise.resolve();
    if (event.catalog) { sequence++; try { apply(event.catalog); } catch(error) { onError(error); } return Promise.resolve(); }
    if (pending?.owner === owner && pending.current()) return pending.promise;
    const ticket = ++sequence, current = capture();
    const promise = (async () => {
      try { const catalog = await read(); if (ticket === sequence && owner === scope() && current()) apply(catalog); }
      catch (error) { if (ticket === sequence && owner === scope() && current()) onError(error); }
    })().finally(()=>{if(pending?.promise===promise)pending=null;});
    pending = {owner,promise,current};return promise;
  }
  return { receive };
}
