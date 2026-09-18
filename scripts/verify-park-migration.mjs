import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSdkHost } from '../app/services/domain/pi-sdk-factory.mjs';
import { listSavedSessions, sameSessionPath } from '../app/services/domain/pi-session-store.mjs';
import { WorkspaceService } from '../app/services/domain/workspace.mjs';

// Validate with a fresh agent directory and a COPY of remembered chat history.
// No model request, OAuth token, or real model configuration is used.
export async function verifyParkMigration(layout, manifest, { sessionDir } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'park-validation-'));
  let host;
  try {
    const agentDir = path.join(temp, 'agent'), sessions = path.join(temp, 'sessions');
    await mkdir(agentDir); await mkdir(sessions);
    let remembered, sessionPath;
    if (manifest.registryFile && sessionDir) {
      const registry = JSON.parse(await readFile(manifest.registryFile, 'utf8'));
      const workspace = registry.items.find(w => sameSessionPath(w.canonicalRoot, layout.workspaceRoot));
      if (!workspace) throw new Error('迁移工作区不在原登记中');
      if (workspace.lastSessionId) {
        remembered = (await listSavedSessions(sessionDir)).find(s => s.id === workspace.lastSessionId && sameSessionPath(s.cwd, layout.workspaceRoot));
        if (!remembered) throw new Error('未找到原工作区记忆的会话，停止迁移验收');
        sessionPath = path.join(sessions, path.basename(remembered.path));
        await copyFile(remembered.path, sessionPath, 1);
      }
    }
    ({ host } = await createSdkHost({ cwd: layout.workspaceRoot, agentDir, sessionDir: sessions, sessionPath, allowMigration: true, log: { warn() {} } }));
    if (remembered && host.session.sessionManager.getSessionId() !== remembered.id) throw new Error('历史会话ID发生变化');
    if (!sameSessionPath(host.session.sessionManager.getCwd(), layout.workspaceRoot)) throw new Error('会话工作目录改变');
    const loader = host.session.resourceLoader;
    const prompt = loader.getAgentsFiles().agentsFiles.find(item => sameSessionPath(item.path, layout.projectPromptFile));
    if (!prompt || prompt.content !== await readFile(layout.projectPromptFile, 'utf8')) throw new Error('SDK未加载宝蛋指令');
    const loaded = loader.getSkills();
    const known = [...loaded.skills.map(s => s.filePath), ...loaded.diagnostics.map(d => d.collision?.loserPath).filter(Boolean)];
    const skillFiles = manifest.files.filter(f => path.basename(f.target) === 'SKILL.md');
    for (const item of skillFiles) if (!known.some(file => sameSessionPath(file, item.target))) throw new Error(`SDK未发现迁移后的技能：${item.target}`);
    await host.session.reload();
    if (host.session.systemPrompt.split('## 宝蛋工作区目录约定').length !== 2) throw new Error('目录指令丢失或重复');
    const files = await new WorkspaceService(layout.workspaceRoot).initialize();
    if (!(await files.tree()).entries.some(e => e.processDirectory && !e.children)) throw new Error('文件界面过程目录标记无效');
    return { sessionRestored: Boolean(remembered), skillsVerified: skillFiles.length, promptVerified: true };
  } finally { await host?.dispose(); await rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { commitMigration } = await import('./migrate-baodan-park.mjs');
  const [file, sessionDir] = process.argv.slice(2);
  const result = await commitMigration(file, (layout, m) => verifyParkMigration(layout, m, { sessionDir }));
  console.log(JSON.stringify({ state: result.state, files: result.files.length }));
}
