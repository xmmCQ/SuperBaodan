import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRuntimeContext } from '../app/services/runtime-context.mjs';
import { createCommands } from '../app/services/commands/index.mjs';
import { WorkspaceService } from '../app/services/domain/workspace.mjs';
import { createTempProject } from './helpers/temp-project.mjs';
import { captureWorkspace, withWorkspaceSnapshot } from '../app/services/workspace-operations.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function setup(t) {
  const temp = await createTempProject('workspace-races-');
  await temp.ensureDir('A'); await temp.ensureDir('B'); await temp.ensureDir('sessions');
  const config = { root: temp.root, publicDir: temp.root, host: '127.0.0.1', port: 0, workspaceDir: temp.resolve('A'), piAgentDir: temp.resolve('agent'), piSessionDir: temp.resolve('sessions'), backupDir: temp.resolve('backups'), todoFile: temp.resolve('todo.md'), vskillFile: temp.resolve('vskills.json'), dailyRecordFile: temp.resolve('records.json'), workspaceFile: temp.resolve('workspaces.json') };
  const context = await createRuntimeContext(config), calls = [];
  const A = context.activeWorkspace, B = await context.workspaceRegistry.add({ name: 'B', path: temp.resolve('B') });
  const sessionPath = temp.resolve('sessions/a.jsonl');
  function runtime(label, root) {
    return { state: 'running', busyReasons: new Set(), pending: new Map(), running: true, activeSessionPath: null,
      listSessions: async () => label === 'A' ? [{ id: 'session-A', cwd: root, path: sessionPath }] : [],
      close: async () => { calls.push(`${label}:close`); }, ensureStarted: async () => {},
      send: async () => ({ sessionId: `fresh-${label}` }),
      openSession: async p => { calls.push(`${label}:open:${p}`); return { sessionId: 'session-A' }; },
      renameSession: async p => { calls.push(`${label}:rename:${p}`); return { renamed: true }; },
      deleteSession: async p => { calls.push(`${label}:delete:${p}`); return { deleted: true }; },
    };
  }
  context.piRuntime = runtime('A', A.canonicalRoot);
  context.createRuntimeServices = async root => ({ piRuntime: runtime(root === B.canonicalRoot ? 'B' : 'A', root), piAdmin: { maintenanceActive: false, close() {} }, workspaceService: await new WorkspaceService(root).initialize(), skillManager: {} });
  const commands = createCommands(context);
  const releases = [];
  t.after(async () => { releases.forEach(r => r()); await context.workspaceSwitchQueue.catch(() => {}); context.piAdmin.close(); await temp.cleanup(); });
  return { temp, context, A, B, sessionPath, calls, releases, invoke: commands.invoke };
}

test('IPC上传排队期间切换A到B：旧工作区请求被拒绝且不写入文件', async t => {
  const h = await setup(t);
  await fs.writeFile(h.temp.resolve('B/same.txt'), 'B original');
  const args = { workspaceId: h.A.id, name: 'same.txt', overwrite: true, content: Buffer.from('incoming') };
  await h.context.activateWorkspace(h.B.id);
  await assert.rejects(h.invoke('files.upload', args), { statusCode: 409 });
  assert.equal(await fs.readFile(h.temp.resolve('B/same.txt'), 'utf8'), 'B original');
  await assert.rejects(fs.stat(h.temp.resolve('A/same.txt')), { code: 'ENOENT' });
});

test('上传已经进入写入阶段时，工作区切换等待写入完成', async t => {
  const h = await setup(t), entered = deferred(), release = deferred(); h.releases.push(release.resolve);
  const service = h.context.workspaceService, upload = service.upload.bind(service);
  service.upload = async (...args) => { entered.resolve(); await release.promise; assert.equal(h.context.activeWorkspace.id, h.A.id); return upload(...args); };
  const posting = h.invoke('files.upload', { workspaceId: h.A.id, name: 'only-A.txt', content: Buffer.from('A contents') });
  await entered.promise;
  let switched = false; const switchWork = h.context.activateWorkspace(h.B.id).then(() => { switched = true; });
  await new Promise(setImmediate); assert.equal(switched, false);
  release.resolve(); assert.equal((await posting).ok, true); await switchWork;
  assert.equal(await fs.readFile(h.temp.resolve('A/only-A.txt'), 'utf8'), 'A contents');
  await assert.rejects(fs.stat(h.temp.resolve('B/only-A.txt')), { code: 'ENOENT' });
});

for (const [action, method, endpoint] of [['open', 'POST', '/api/sessions/activate'], ['rename', 'POST', '/api/sessions/rename'], ['delete', 'DELETE', '/api/sessions']]) {
  test(`会话${action}归属扫描期间切换：全过程锁定A，B运行时和最后会话不被污染`, async t => {
    const h = await setup(t), entered = deferred(), release = deferred(); h.releases.push(release.resolve);
    await h.context.workspaceRegistry.setActive(h.A.id, 'session-A'); h.context.activeWorkspace = h.context.workspaceRegistry.active();
    const scan = h.context.piRuntime.listSessions;
    h.context.piRuntime.listSessions = async () => { entered.resolve(); await release.promise; return scan(); };
    const pending = h.invoke('sessions.' + (action === 'open' ? 'activate' : action), { workspaceId: h.A.id, path: h.sessionPath, name: 'renamed' });
    await entered.promise;
    let switchEntered = false; const validate = h.context.workspaceRegistry.validateRegistered.bind(h.context.workspaceRegistry);
    h.context.workspaceRegistry.validateRegistered = (...args) => { switchEntered = true; return validate(...args); };
    const switching = h.context.activateWorkspace(h.B.id);
    await new Promise(setImmediate); assert.equal(switchEntered, false);
    release.resolve(); assert.equal((await pending).ok, true); await switching;
    assert.ok(h.calls.includes(`A:${action}:${h.sessionPath}`)); assert.equal(h.calls.some(c => c.startsWith(`B:${action}:`)), false);
    const registry = await h.context.workspaceRegistry.list();
    assert.equal(registry.items.find(w => w.id === h.A.id).lastSessionId, action === 'delete' ? null : 'session-A');
    assert.notEqual(registry.items.find(w => w.id === h.B.id).lastSessionId, 'session-A');
  });
}

test('旧IPC请求与A→B→A的旧快照被拒绝，失败不阻塞后续队列', async t => {
  const h = await setup(t);
  const old = captureWorkspace(h.context, h.A.id);
  await h.context.activateWorkspace(h.B.id);
  await assert.rejects(h.invoke('sessions.activate', { workspaceId: h.A.id, path: h.sessionPath }), { statusCode: 409 });
  await h.context.activateWorkspace(h.A.id);
  await assert.rejects(withWorkspaceSnapshot(h.context, old, h.A.id, () => assert.fail('stale callback')), { statusCode: 409 });
  const current = captureWorkspace(h.context, h.A.id);
  assert.equal(await withWorkspaceSnapshot(h.context, current, h.A.id, () => 'ok'), 'ok');
});
