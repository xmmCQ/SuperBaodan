import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationDataPrompt } from '../app/services/domain/app-data-context.mjs';
import { createAgentContext } from './helpers/agent-context.mjs';
import { findSdkEntry } from '../app/services/domain/pi-sdk-factory.mjs';
import { createTempProject } from './helpers/temp-project.mjs';

const paths = { todoFile: 'E:\\用户 数据\\work-todo.md', dailyRecordFile: 'E:\\用户 数据\\daily-records.json' };
test('应用路径提示只携带运行配置，不依赖安装目录或预读文件', () => {
  const prompt = applicationDataPrompt(paths);
  assert.ok(prompt.includes(JSON.stringify(paths, null, 2)));
  assert.match(prompt, /无关问题不要读取/);
  assert.match(prompt, /不自动混入每日记录/);
  assert.match(prompt, /不把读取失败当成没有事项/);
  assert.equal(applicationDataPrompt(), '');
  assert.throws(() => applicationDataPrompt({ ...paths, todoFile: 'data/work-todo.md' }), /路径无效/);
});

test('真实SDK：应用路径保留项目提示，重载、恢复会话和切换工作区后仍有效', {
  skip: process.platform !== 'win32' || process.env.SUPER_BAODAN_TEST_SDK !== '1' || !findSdkEntry(),
  timeout: 45000,
}, async () => {
  const temp = await createTempProject('sb-app-data-context-');
  const oldOffline = process.env.PI_OFFLINE, oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_OFFLINE = '1';
  let context;
  try {
    const config = {
      root: temp.resolve('installation'), workspaceDir: await temp.ensureDir('workspace'),
      piAgentDir: await temp.ensureDir('agent'), piSessionDir: temp.resolve('sessions'),
      backupDir: temp.resolve('backups'), todoFile: temp.resolve('应用 数据/work-todo.md'),
      dailyRecordFile: temp.resolve('应用 数据/daily-records.json'),
      vskillFile: temp.resolve('vskills.json'), workspaceFile: temp.resolve('workspaces.json'),
    };
    await temp.write('应用 数据/work-todo.md', '# 工作待办\n- [x] 隔离回归事项\n');
    await temp.write('workspace/AGENTS.md', 'PROJECT_CONTEXT_MUST_REMAIN');
    await temp.write('agent/APPEND_SYSTEM.md', 'USER_APPEND_MUST_REMAIN');
    await temp.writeJson('agent/settings.json', { packages: [] });
    context = await createAgentContext(config);
    const expected = applicationDataPrompt({ todoFile: config.todoFile, dailyRecordFile: config.dailyRecordFile });
    const check = () => {
      const prompt = context.piRuntime.host.session.agent.state.systemPrompt;
      assert.ok(prompt.includes(expected));
      assert.equal(prompt.split('## 超级宝蛋当前应用数据位置').length - 1, 1);
      assert.ok(prompt.includes('USER_APPEND_MUST_REMAIN'));
    };
    await context.piRuntime.ensureStarted(); check();
    assert.ok(context.piRuntime.host.session.agent.state.systemPrompt.includes('PROJECT_CONTEXT_MUST_REMAIN'));
    await context.piRuntime.host.session.reload(); check();
    const result = await context.piRuntime.host.session.agent.state.tools.find(tool => tool.name === 'read')
      .execute('read-app-todo', { path: config.todoFile });
    assert.ok(result.content.some(item => item.text?.includes('隔离回归事项')));
    const sessionId = context.piRuntime.host.session.sessionId;
    await context.piRuntime.stop('idle');
    await context.piRuntime.ensureStarted(); check();
    assert.equal(context.piRuntime.host.session.sessionId, sessionId);
    const root=await temp.ensureDir('另一个 工作区'),target={id:'other',root,canonicalRoot:root,name:'另一个工作区'};
    await context.prepareSwitch({operationId:'switch-app-path',workspace:target,epoch:1});
    await context.commitSwitch({operationId:'switch-app-path',epoch:1});
    await context.piRuntime.ensureStarted(); check();
    assert.deepEqual(context.piRuntime.dataPaths, { todoFile: config.todoFile, dailyRecordFile: config.dailyRecordFile });
  } finally {
    await context?.shutdown();
    if (oldOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = oldOffline;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await temp.cleanup();
  }
});
