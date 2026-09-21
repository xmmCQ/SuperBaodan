import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillCli, buildSkillCliArgs } from '../app/services/domain/skill-cli.mjs';
import { createTempProject } from './helpers/temp-project.mjs';

test('Skill CLI路径和参数保持不变，项目cwd明确传入，全局不指定cwd', async t => {
  const temp = await createTempProject('skill-cli-'); t.after(temp.cleanup);
  const cliPath = await temp.write('npx-cli.js', '// fixture');
  const calls = [], warnings = [];
  const cli = new SkillCli({ env: { SUPER_BAODAN_NPX_CLI: cliPath }, execFileImpl: async (...args) => { calls.push(args); return { stdout: '\u001b[32mInstallation complete\u001b[0m' }; }, log: { warn: text => warnings.push(text) } });
  assert.equal(await cli.isCliAvailable(), true);
  const args = buildSkillCliArgs('install', { package: 'owner/repo@demo', scope: 'project' });
  assert.equal(await cli.runCli(args, { cwd: temp.root }), 'Installation complete');
  assert.equal(calls[1][0], process.execPath);
  assert.deepEqual(calls[1][1], [cliPath, ...args]);
  assert.equal(calls[1][2].cwd, temp.root); assert.equal(calls[1][2].timeout, 90000); assert.equal(calls[1][2].maxBuffer, 32000); assert.equal(calls[1][2].env.FORCE_COLOR, '0');
  await cli.runCli([...args, '-g'], { cwd: temp.root }); assert.equal(calls[2][2].cwd, undefined);
  assert.deepEqual(warnings, []);
});
test('Skill CLI失败保留502及路径隐藏，不执行维护锁或回滚逻辑', async () => {
  const cli = new SkillCli({ env: {}, execFileImpl: async () => { throw Object.assign(new Error('failed /private/agent'), { stderr: '\u001b[31m/private/home\n/private/project' }); } });
  await assert.rejects(cli.runCli(['skills'], { sensitivePaths: ['/private/agent','/private/home','/private/project'] }), error => error.statusCode === 502 && !error.message.includes('/private/') && !error.message.includes('\n') && error.message.includes('<本地路径>'));
  await assert.rejects(cli.requireCli(), { statusCode: 503 });
});
