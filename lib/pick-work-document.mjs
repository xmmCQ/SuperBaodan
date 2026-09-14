import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fail } from '../public/core/work-documents.js';
const execute = promisify(execFile);
// Fixed script only; no user input is interpolated into PowerShell code.
export const FILE_PICKER_SCRIPT = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
Add-Type -ReferencedAssemblies System.Windows.Forms @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public sealed class WorkDocumentDialogOwner : IWin32Window {
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  public IntPtr Handle { get; private set; }
  public WorkDocumentDialogOwner() {
    IntPtr window = GetForegroundWindow();
    Handle = IsWindowVisible(window) ? window : IntPtr.Zero;
  }
}
'@
$picker=New-Object System.Windows.Forms.OpenFileDialog
$owner=New-Object WorkDocumentDialogOwner
try {
  $picker.Title='选择工作文档'
  $picker.Filter='工作文档|*.doc;*.docx;*.xls;*.xlsx;*.ppt;*.pptx;*.pdf;*.txt;*.md;*.csv;*.rtf;*.wps;*.et;*.dps;*.png;*.jpg;*.jpeg;*.webp'
  $picker.Multiselect=$false
  $picker.CheckFileExists=$true
  $picker.CheckPathExists=$true
  $picker.RestoreDirectory=$true
  if($owner.Handle -eq [IntPtr]::Zero) { $result=$picker.ShowDialog() }
  else { $result=$picker.ShowDialog($owner) }
  if($result -eq [System.Windows.Forms.DialogResult]::OK) {
    @{cancelled=$false;path=$picker.FileName}|ConvertTo-Json -Compress
  } else { @{cancelled=$true}|ConvertTo-Json -Compress }
} finally { $picker.Dispose() }
`;
export async function pickWorkDocument({ signal } = {}, run = execute) {
  if (process.platform !== 'win32') throw fail('浏览本地文件需要 Windows', 503);
  try {
    const { stdout } = await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(FILE_PICKER_SCRIPT, 'utf16le').toString('base64')],
      { signal, timeout: 180000, maxBuffer: 16384, windowsHide: true, encoding: 'utf8' });
    const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (result.cancelled === true) return { cancelled: true };
    if (result.cancelled !== false || typeof result.path !== 'string') throw new Error('invalid result');
    return result;
  } catch (error) {
    if (signal?.aborted) throw fail('已取消文件选择', 499);
    if (error.killed) throw fail('文件选择超时，请重新选择', 408);
    throw fail('无法打开文件选择窗口，请重试或直接粘贴完整路径', 502);
  }
}
