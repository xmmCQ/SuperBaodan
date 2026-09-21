import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAgentClient } from '../app/renderer/core/agent-client.js';
import { createBootstrapLoader } from '../app/renderer/core/bootstrap-loader.js';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const data = id => ({ workspace: { id }, state: { sessionId: `${id}-session` }, messages: [] });
const main = await readFile(new URL('../app/renderer/assistant/main.js', import.meta.url), 'utf8');
const applySource = main.slice(main.indexOf('async function applyBootstrap('), main.indexOf('\nfunction handleAgentEvent('));

test('完整助手异步模型读取后重新检查current，旧成功或失败不能覆盖新工作区', async () => {
  for (const failOld of [false, true]) {
    const gate = deferred(), writes = [], errors = []; let scope = 'A';
    const record = label => (...args) => writes.push([label, ...args]);
    const models = { resolveEnabledModels: value => value === 'A' ? gate.promise : Promise.resolve(value), setEnabledModels: record('models'), renderModels() {}, renderThinking() {} };
    const workspace = { setWorkspace: record('workspace'), workspace: () => ({ id: scope }), setTurnFiles() {}, refreshWorkspaceTreeIfOpen: async () => {} };
    const chat = { setRuntimeState() {}, renderMessages: record('messages'), setRuntime: record('runtime'), startResponseFallback: record('fallback') };
    const apply = new Function('models','workspace','workspaceSwitcher','sessions','chat','updateStateFromAgent', `return ${applySource}`)(models, workspace, { sync() {} }, { setCurrentSession: record('session'), renderSessions() {} }, chat, () => {});
    const client = { bootstrap: async () => ({ ...data(scope), enabledModels: scope, state: { isStreaming: true, sessionId: scope }, messages: [scope] }) };
    const load = createBootstrapLoader({ client, getWorkspaceId: () => scope, apply, onError: error => errors.push(error.message) });
    const old = load(); await Promise.resolve(); scope = 'B'; await load();
    if (failOld) gate.reject(new Error('old')); else gate.resolve('A');
    await old;
    assert.deepEqual(writes.filter(([label]) => label === 'models'), [['models','B']]);
    assert.deepEqual(writes.filter(([label]) => label === 'session'), [['session','B']]);
    assert.equal(writes.filter(([label]) => label === 'fallback').length, 1);
    assert.deepEqual(errors, []);
  }
});
test('当前初始化失败仍报告错误，准备回调在请求前执行', async () => {
  const calls = [];
  const load = createBootstrapLoader({ getWorkspaceId: () => 'A', beforeLoad: () => calls.push('prepare'), client: { bootstrap: async () => { calls.push('request'); throw new Error('current failure'); } }, apply: () => assert.fail(), onError: e => calls.push(e.message) });
  await load(); assert.deepEqual(calls, ['prepare','request','current failure']);
});

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
