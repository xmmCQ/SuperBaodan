import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { layers } from '../test/layers.mjs';

export function selectTests(scope, filters, available, registry = layers) {
  if (scope !== 'all' && !Object.hasOwn(registry, scope)) throw new Error(`未知测试层级：${scope}`);
  const registered = Object.values(registry).flat();
  const seen = new Set();
  for (const file of registered) {
    if (seen.has(file)) throw new Error(`测试重复归类：${file}`);
    if (!available.includes(file)) throw new Error(`测试文件不存在：${file}`);
    seen.add(file);
  }
  const missing = available.filter(file => !seen.has(file));
  if (missing.length) throw new Error(`请在 test/layers.mjs 归类新测试：${missing.join(', ')}`);
  const candidates = scope === 'all' ? registered : registry[scope];
  const selected = new Set();
  for (const filter of filters) {
    const key = filter.replaceAll('\\', '/').split('/').at(-1);
    const matches = candidates.filter(file => file.includes(key));
    if (!matches.length) throw new Error(`该层没有匹配的测试：${filter}`);
    matches.forEach(file => selected.add(file));
  }
  return (filters.length ? [...selected] : [...candidates]).sort();
}

export function parseArguments(args) {
  const [scope = 'unit', ...rest] = args;
  const filters = [], nodeOptions = []; let list = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--') continue;
    if (arg === '--list') list = true;
    else if (arg.startsWith('--test-name-pattern=')) nodeOptions.push(arg);
    else if (arg === '--test-name-pattern') {
      if (!rest[i + 1]) throw new Error('缺少测试名称匹配表达式');
      nodeOptions.push(`--test-name-pattern=${rest[++i]}`);
    } else if (arg.startsWith('-')) throw new Error(`不支持的测试参数：${arg}`);
    else filters.push(arg);
  }
  return { scope, filters, nodeOptions, list };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const options = parseArguments(process.argv.slice(2));
    const files = selectTests(options.scope, options.filters, readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.mjs')));
    if (options.list) console.log(files.map(file => `test/${file}`).join('\n'));
    else {
      console.log(`[${options.scope}] ${files.length} 个测试文件`);
      const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...options.nodeOptions, ...files.map(file => `test/${file}`)], { cwd: root, stdio: 'inherit' });
      child.on('error', error => { console.error(error.message); process.exitCode = 1; });
      child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
