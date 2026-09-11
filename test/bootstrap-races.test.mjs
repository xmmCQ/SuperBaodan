import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentClient } from '../public/core/agent-client.js';
import { createBootstrapLoader } from '../public/core/bootstrap-loader.js';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const data = id => ({ workspace: { id }, state: { sessionId: `${id}-session` }, messages: [] });

test('B先返回、A后返回不覆盖客户端或界面；旧错误不显示欢迎页', async () => {
  for (const failed of [false, true]) {
    const pending = [], applied = [], errors = []; let workspace = 'A';
    const client = createAgentClient({ getWorkspaceId: () => workspace, request: () => { const gate = deferred(); pending.push(gate); return gate.promise; } });
    const load = createBootstrapLoader({ client, getWorkspaceId: () => workspace, apply: d => applied.push(d.workspace.id), onError: e => errors.push(e) });
    const a = load(); workspace = 'B'; const b = load();
    pending[1].resolve(data('B')); await b;
    if (failed) pending[0].reject(new Error('old failure')); else pending[0].resolve(data('A'));
    await a;
    assert.equal(client.state().workspace.id, 'B'); assert.equal(client.state().sessionId, 'B-session');
    assert.deepEqual(applied, ['B']); assert.deepEqual(errors, []);
  }
});
test('同工作区请求代次和A→B→A均拦截旧初始化响应', async () => {
  const pending = []; let workspace = 'A';
  const client = createAgentClient({ getWorkspaceId: () => workspace, request: () => { const gate = deferred(); pending.push(gate); return gate.promise; } });
  const a = client.bootstrap(); a.catch(() => {}); const b = client.bootstrap();
  pending[1].resolve(data('A')); await b; pending[0].resolve({ ...data('A'), state: { sessionId: 'old' } });
  await assert.rejects(a, { staleResponse: true }); assert.equal(client.state().sessionId, 'A-session');
  const old = client.bootstrap(); old.catch(() => {});
  workspace = 'B'; client.applyEvent({ type: 'workspace_changed', workspace: { id: 'B' } });
  workspace = 'A'; client.applyEvent({ type: 'workspace_changed', workspace: { id: 'A' } });
  pending[2].resolve(data('A')); await assert.rejects(old, { staleResponse: true });
});
test('首次请求未绑定工作区时，不能覆盖已连接的新工作区', async () => {
  const gate = deferred(), client = createAgentClient({ request: () => gate.promise });
  const pending = client.bootstrap(); pending.catch(() => {});
  client.applyEvent({ type: 'connected', workspace: { id: 'B' } }); gate.resolve(data('A'));
  await assert.rejects(pending, { staleResponse: true }); assert.equal(client.state().workspace.id, 'B');
});
