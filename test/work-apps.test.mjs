import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkApps, validateWorkApps } from '../lib/work-apps.mjs';
import { createTempProject } from './helpers/temp-project.mjs';
import { createServerApplication } from '../server/app.mjs';
const apps = [{ id: 'one', name: '测试软件', path: 'C:\\Apps\\测试软件.exe', enabled: true, processes: ['Test'] }, { id: 'two', name: '快捷方式', path: 'D:\\Apps\\Link.lnk', enabled: false, processes: [] }];

test('软件配置校验、版本冲突、备份、排序启用和启动互斥', async t => {
  const temp = await createTempProject('work-apps-'); t.after(() => temp.cleanup());
  let launched, release;
  const manager = new WorkApps({ filePath: temp.resolve('apps.json'), defaults: apps, launch: async values => { launched = values; return new Promise(resolve => { release = () => resolve({ results: [] }); }); } });
  const first = await manager.read(); assert.equal(first.apps.length, 2);
  const next = await manager.save({ revision: first.revision, apps: [apps[1], apps[0]] });
  assert.equal(next.apps[0].id, 'two');
  await assert.rejects(manager.save({ revision: first.revision, apps }), { statusCode: 409 });
  const updated = await manager.save({ revision: next.revision, apps: next.apps.map(a => a.id === 'one' ? { ...a, path: 'C:\\New\\Other.exe' } : a) });
  assert.deepEqual(updated.apps[1].processes, []);
  assert.equal(JSON.parse(await fs.readFile(temp.resolve('apps.json.bak'), 'utf8')).apps[0].id, 'two');
  const pending = manager.run();
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(launched.map(a => a.id), ['one']);
  await assert.rejects(manager.run(), { statusCode: 409 }); release(); await pending;
  await assert.rejects(manager.run('missing'), { statusCode: 404 });
  await assert.rejects(manager.run('one', 'old'), { statusCode: 409 });
  const empty = await manager.save({ revision: updated.revision, apps: [] });
  assert.equal(empty.apps.length, 0); assert.deepEqual((await manager.run()).results, []);
  await fs.writeFile(temp.resolve('apps.json'), '{bad'); await assert.rejects(manager.read(), { statusCode: 409 });
});

test('拒绝脚本、相对路径、命令参数、重复ID；允许空格中文快捷方式', () => {
  for (const target of ['app.exe', '\\\\server\\share\\app.exe', 'C:\\a.ps1', 'C:\\app.exe -arg', 'C:\\a.exe:stream.exe']) assert.throws(() => validateWorkApps([{ ...apps[0], path: target }]));
  assert.throws(() => validateWorkApps([apps[0], apps[0]]));
  assert.equal(validateWorkApps([{ ...apps[0], path: '"D:\\测试 文件夹\\快捷方式.lnk"' }])[0].path, 'D:\\测试 文件夹\\快捷方式.lnk');
});

test('软件API支持配置与单独启动，拒绝跨站启动和错误版本', async t => {
  const temp = await createTempProject('work-apps-api-'); let launched = [];
  const manager = new WorkApps({ filePath: temp.resolve('apps.json'), defaults: apps, launch: async values => { launched = values; return { results: values.map(a => ({ name: a.name, status: 'started', message: '测试启动请求' })) }; } });
  const context = { config: { host: '127.0.0.1', port: 0, publicDir: path.resolve('public') }, workApps: manager, openWorkApps: () => manager.run(), attachServer() {} };
  const server = createServerApplication(context); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); context.config.port = server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await temp.cleanup(); });
  const base = `http://127.0.0.1:${context.config.port}`;
  const request = (url, method = 'GET', body, extra = {}) => fetch(base + url, { method, ...(body ? { body: JSON.stringify(body) } : {}), headers: { 'Content-Type': 'application/json', ...extra } });
  const initial = await (await request('/api/apps/config')).json();
  assert.equal((await request('/api/apps/config', 'PUT', { ...initial, apps: [apps[1], apps[0]] })).status, 200);
  const current = await (await request('/api/apps/config')).json();
  assert.equal((await request('/api/apps/open', 'POST', { id: 'two', revision: current.revision })).status, 200); assert.equal(launched[0].id, 'two');
  assert.equal((await request('/api/apps/open', 'POST', { id: '', revision: current.revision })).status, 400);
  assert.equal((await request('/api/apps/open-all', 'POST', null, { Origin: 'https://example.invalid' })).status, 403);
  assert.equal((await request('/api/apps/open-all', 'POST')).status, 200); assert.deepEqual(launched.map(a => a.id), ['one']);
});

test('Windows启动脚本通过标准输入接收配置并安全DryRun，不启动软件', async t => {
  if (process.platform !== 'win32') return t.skip('仅Windows运行');
  const temp = await createTempProject('work-apps-dry-'); t.after(() => temp.cleanup());
  const target = temp.resolve("中文 & ' [文件].exe"); await fs.writeFile(target, 'fixture');
  const values = [{ ...apps[0], path: target, processes: [] }, { ...apps[1], path: temp.resolve('missing.exe') }];
  const pending = promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/open-work-apps.ps1'), '-ReadAppsFromStdin', '-DryRun'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  pending.child.stdin.end(Buffer.from(JSON.stringify(values), 'utf8').toString('base64'));
  const { stdout } = await pending, result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  assert.equal(result[0].status, 'dry_run'); assert.equal(result[0].name, '测试软件'); assert.equal(result[1].status, 'failed');
});
