import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
async function files(dir) { const result = []; for (const e of await readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) result.push(...await files(p)); else result.push(p); } return result; }

test('应用只有main/preload/renderer/services/shared五个职责边界', async () => {
  assert.deepEqual((await readdir(path.join(ROOT, 'app'))).sort(), ['main','preload','renderer','services','shared']);
});
test('业务进程不引用界面实现，公共规则来自shared', async () => {
  for (const file of await files(path.join(ROOT, 'app/services'))) {
    if (!file.endsWith('.mjs')) continue;
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /from\s+['"][^'"]*(?:public|renderer)\//, file);
    assert.doesNotMatch(text, /createServer\(|text\/event-stream|router\.(get|post)/, file);
  }
});
test('界面通过应用命令通信，不再包含本地HTTP API或SSE', async () => {
  for (const file of await files(path.join(ROOT, 'app/renderer'))) {
    if (!file.endsWith('.js')) continue;
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /\/api\/|new EventSource|fetch\(/, file);
  }
});
test('应用所有相对模块引用指向存在文件', async () => {
  for (const file of await files(path.join(ROOT, 'app'))) {
    if (!/\.(?:mjs|js|cjs)$/.test(file)) continue;
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g)) {
      await assert.doesNotReject(access(path.resolve(path.dirname(file), match[2].split('?')[0])), `${file}: ${match[2]}`);
    }
  }
});
