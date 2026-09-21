import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export async function launchWorkApps(apps, { appScript, execFileImpl = execFileAsync }) {
  const encoded = Buffer.from(JSON.stringify(apps), 'utf8').toString('base64');
  const execution = execFileImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', appScript, '-ReadAppsFromStdin'], { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true });
  execution.child.stdin.on('error', () => {});
  execution.child.stdin.end(encoded);
  const { stdout, stderr } = await execution;
  const results = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  return { results: Array.isArray(results) ? results : [results], warning: stderr.trim() || null };
}
