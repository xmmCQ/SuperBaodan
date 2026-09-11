import { mutationError } from '../lib/task-writer.mjs';

export function captureWorkspace(context, requestedId) {
  context.assertActiveWorkspace(requestedId);
  if (!context.activeWorkspace || context.workspaceSwitching) throw mutationError(409, '工作区正在切换，请重试');
  return {
    workspace: { ...context.activeWorkspace }, runtime: context.piRuntime,
    files: context.workspaceService, epoch: context.workspaceEpoch || 0,
  };
}
export function assertWorkspaceSnapshot(context, snapshot, requestedId) {
  if (requestedId && requestedId !== snapshot.workspace.id) throw mutationError(409, '请求工作区与开始时的工作区不一致，请刷新后重试');
  if (context.workspaceSwitching || context.activeWorkspace?.id !== snapshot.workspace.id ||
      context.piRuntime !== snapshot.runtime || context.workspaceService !== snapshot.files ||
      (context.workspaceEpoch || 0) !== snapshot.epoch) {
    throw mutationError(409, '工作区已变化，已取消操作，请刷新后重试');
  }
}
export function enqueueWorkspaceOperation(context, operation) {
  const result = (context.workspaceSwitchQueue || Promise.resolve()).then(() => {
    if (context.shuttingDown) throw mutationError(503, '工作台正在退出');
    return operation();
  });
  context.workspaceSwitchQueue = result.catch(() => {});
  return result;
}
export function withWorkspaceSnapshot(context, snapshot, requestedId, operation) {
  return enqueueWorkspaceOperation(context, async () => {
    assertWorkspaceSnapshot(context, snapshot, requestedId);
    return operation(snapshot);
  });
}
