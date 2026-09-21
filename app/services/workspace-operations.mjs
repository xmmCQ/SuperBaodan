import { fault } from '../shared/errors.js';


export function captureWorkspace(context, requestedId) {
  context.assertActiveWorkspace(requestedId);
  if (!context.activeWorkspace || context.workspaceSwitching) throw fault(409, '工作区正在切换，请重试');
  return {
    workspace: { ...context.activeWorkspace }, runtime: context.piRuntime, admin: context.piAdmin,
    files: context.workspaceService, epoch: context.workspaceEpoch || 0,
  };
}
export function assertWorkspaceSnapshot(context, snapshot, requestedId) {
  if (requestedId && requestedId !== snapshot.workspace.id) throw fault(409, '请求工作区与开始时的工作区不一致，请刷新后重试');
  if (context.workspaceSwitching || context.activeWorkspace?.id !== snapshot.workspace.id ||
      context.piRuntime !== snapshot.runtime || context.workspaceService !== snapshot.files ||
      (context.workspaceEpoch || 0) !== snapshot.epoch) {
    throw fault(409, '工作区已变化，已取消操作，请刷新后重试');
  }
}
export function enqueueWorkspaceOperation(context, operation) {
  const result = (context.workspaceSwitchQueue || Promise.resolve()).then(() => {
    if (context.shuttingDown) throw fault(503, '工作台正在退出');
    return operation();
  });
  context.workspaceSwitchQueue = result.catch(() => {});
  return result;
}
export function withWorkspaceSnapshot(context, snapshot, requestedId, operation, { signal, maintenance = false } = {}) {
  return enqueueWorkspaceOperation(context, async () => {
    assertWorkspaceSnapshot(context, snapshot, requestedId);
    if (maintenance && snapshot.admin?.maintenanceActive) throw fault(409, '配置维护中，请稍后重试');
    if (signal?.aborted) throw fault(499, '操作已取消');
    return operation(snapshot);
  });
}
