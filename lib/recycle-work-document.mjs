import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fail } from '../public/core/work-documents.js';
const execute = promisify(execFile);
// RECYCLEONDELETE explicitly forbids falling back to permanent deletion.
// The filename is passed through an environment variable, never script interpolation.
export const RECYCLE_SCRIPT = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
[ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IRecycleOperation {
 [PreserveSig] int Advise(IntPtr sink, out uint cookie);
 [PreserveSig] int Unadvise(uint cookie);
 [PreserveSig] int SetOperationFlags(uint flags);
 [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
 [PreserveSig] int SetProgressDialog(IntPtr dialog);
 [PreserveSig] int SetProperties(IntPtr properties);
 [PreserveSig] int SetOwnerWindow(uint owner);
 [PreserveSig] int ApplyPropertiesToItem([MarshalAs(UnmanagedType.Interface)] object item);
 [PreserveSig] int ApplyPropertiesToItems([MarshalAs(UnmanagedType.IUnknown)] object items);
 [PreserveSig] int RenameItem([MarshalAs(UnmanagedType.Interface)] object item, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
 [PreserveSig] int RenameItems([MarshalAs(UnmanagedType.IUnknown)] object items, [MarshalAs(UnmanagedType.LPWStr)] string name);
 [PreserveSig] int MoveItem([MarshalAs(UnmanagedType.Interface)] object item, [MarshalAs(UnmanagedType.Interface)] object destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
 [PreserveSig] int MoveItems([MarshalAs(UnmanagedType.IUnknown)] object items, [MarshalAs(UnmanagedType.Interface)] object destination);
 [PreserveSig] int CopyItem([MarshalAs(UnmanagedType.Interface)] object item, [MarshalAs(UnmanagedType.Interface)] object destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
 [PreserveSig] int CopyItems([MarshalAs(UnmanagedType.IUnknown)] object items, [MarshalAs(UnmanagedType.Interface)] object destination);
 [PreserveSig] int DeleteItem([MarshalAs(UnmanagedType.Interface)] object item, IntPtr sink);
 [PreserveSig] int DeleteItems([MarshalAs(UnmanagedType.IUnknown)] object items);
 [PreserveSig] int NewItem([MarshalAs(UnmanagedType.Interface)] object destination, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, IntPtr sink);
 [PreserveSig] int PerformOperations();
 [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
}
public static class WorkDocumentRecycle {
 [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=true)]
 static extern int SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object item);
 public static void Run(string file) {
  if (!Path.IsPathRooted(file) || file.StartsWith(@"\\")) throw new IOException("Only local files can be recycled");
  if (new DriveInfo(Path.GetPathRoot(file)).DriveType != DriveType.Fixed) throw new IOException("A fixed local drive is required");
  var attrs=File.GetAttributes(file);
  if ((attrs & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) throw new IOException("Not a regular file");
  var op=(IRecycleOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
  object item=null;
  try {
   // FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE | FOF_NOERRORUI | FOF_NOCONFIRMATION | FOF_SILENT
   Marshal.ThrowExceptionForHR(op.SetOperationFlags(0x00080000 | 0x00100000 | 0x400 | 0x10 | 0x4));
   Guid iid=new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
   Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(file,IntPtr.Zero,ref iid,out item));
   Marshal.ThrowExceptionForHR(op.DeleteItem(item,IntPtr.Zero));
   Marshal.ThrowExceptionForHR(op.PerformOperations());
   bool aborted; Marshal.ThrowExceptionForHR(op.GetAnyOperationsAborted(out aborted));
   if (aborted || File.Exists(file)) throw new IOException("Recycling was not completed");
  } finally { if(item!=null) Marshal.ReleaseComObject(item); Marshal.ReleaseComObject(op); }
 }
}
'@
[WorkDocumentRecycle]::Run($env:SUPERBAODAN_RECYCLE_TARGET)
`;
export async function recycleWorkDocument(file, run = execute) {
  if (process.platform !== 'win32') throw fail('移入回收站需要 Windows', 503);
  try {
    await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(RECYCLE_SCRIPT, 'utf16le').toString('base64')],
      { env: { ...process.env, SUPERBAODAN_RECYCLE_TARGET: file }, timeout: 60000, maxBuffer: 32768, windowsHide: true, encoding: 'utf8' });
  } catch { throw fail('未能确认源文件已移入回收站，入口已保留；请检查文件占用、权限或回收站状态，不会改为永久删除', 502); }
}
