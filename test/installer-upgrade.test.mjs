import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = process.env.SUPER_BAODAN_PACKAGING_DIR || 'D:/SuperBaodan-Packaging/online-0.0.1';

test('升级安装沿用原目录，快捷方式按目标归属更新，组件已缓存仍检查进程', async t => {
  if (!existsSync(path.join(root, 'installer.iss'))) return t.skip('外部安装脚本目录不可用');
  const source = await fs.readFile(path.join(root, 'installer.iss'), 'utf8');
  assert.match(source, /UsePreviousAppDir=yes/);
  assert.match(source, /Inno Setup: App Path/);
  assert.match(source, /Link\.TargetPath/);
  assert.match(source, /CompareText\(Target, OldRoot \+ TargetName\)/);
  assert.match(source, /ShouldUpdateLegacyDesktopIcon/);
  assert.ok(source.indexOf(' -CheckOnly') < source.indexOf('if RuntimeReady then exit'));
  const runtime = await fs.readFile(path.join(root, 'setup-runtime.ps1'), 'utf8');
  assert.match(runtime, /Get-InstalledRuntimeConflicts -InstallDirs @\(\$InstallDir, \$PreviousInstallDir\)/);
  assert.ok(runtime.indexOf('if ($CheckOnly)') < runtime.indexOf('Expand-Archive'));
});
test('安装进程检查覆盖旧/新目录，排除源码版、其他Node及相似前缀路径', async t => {
  if (process.platform !== 'win32' || !existsSync(path.join(root, 'upgrade-support.ps1'))) return t.skip('需要Windows及外部安装脚本');
  const helper = path.join(root, 'upgrade-support.ps1').replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();. '${helper}';$p=@(
    [pscustomobject]@{Id=1;Path='C:\\Old\\runtime\\node\\node.exe'},
    [pscustomobject]@{Id=2;Path='D:\\New\\SuperBaodan.exe'},
    [pscustomobject]@{Id=3;Path='C:\\Program Files\\nodejs\\node.exe'},
    [pscustomobject]@{Id=4;Path='C:\\Old-copy\\runtime\\node\\node.exe'});
    $ids=@(Get-InstalledRuntimeConflicts -InstallDirs @('D:\\New','C:\\Old') -Processes $p | ForEach-Object {$_.Id});ConvertTo-Json -InputObject $ids -Compress`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10000, encoding: 'utf8', windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), [1, 2]);
});
