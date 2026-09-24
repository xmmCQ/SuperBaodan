import { spawn } from 'node:child_process';

// Short-lived system PowerShell only. The duplicated Job handle lives in the
// Electron parent, so Windows closes it (and its children) even on a hard crash.
const native = `
using System; using System.Runtime.InteropServices;
public static class BaodanJob {
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long ProcessTime,JobTime; public uint Flags; public UIntPtr Min,Max; public uint Count; public UIntPtr Affinity; public uint Priority,Schedule; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A,B,C,D,E,F; }
 [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic Basic; public Io Io; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits info,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint rights,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
 static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
 public static long Attach(int parent,int child,string name) {
  IntPtr owner=OpenProcess(0x40,false,parent), target=OpenProcess(0x101,false,child), job=CreateJobObject(IntPtr.Zero,name), copy;
  try { Check(owner!=IntPtr.Zero && target!=IntPtr.Zero && job!=IntPtr.Zero); var limits=new Limits(); limits.Basic.Flags=0x2000;
   Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits)))); Check(AssignProcessToJobObject(job,target));
   Check(DuplicateHandle(GetCurrentProcess(),job,owner,out copy,0,false,2)); return copy.ToInt64();
  } finally { if(target!=IntPtr.Zero)CloseHandle(target); if(owner!=IntPtr.Zero)CloseHandle(owner); if(job!=IntPtr.Zero)CloseHandle(job); }
 }
 public static void Release(int parent,long value,string name,bool closeSource) {
  IntPtr job=OpenJobObject(0x0008,false,name), owner=IntPtr.Zero, copy=IntPtr.Zero;
  if(job==IntPtr.Zero) { if(Marshal.GetLastWin32Error()==2)return; Check(false); }
  try { Check(TerminateJobObject(job,1));
   if(closeSource) { owner=OpenProcess(0x40,false,parent); if(owner!=IntPtr.Zero)Check(DuplicateHandle(owner,new IntPtr(value),GetCurrentProcess(),out copy,0,false,3)); }
  } finally { if(copy!=IntPtr.Zero)CloseHandle(copy); if(owner!=IntPtr.Zero)CloseHandle(owner); CloseHandle(job); }
 }
}`;
function powershell(body) {
  return new Promise((resolve,reject)=>{
    const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${native}\n'@; ${body}`;
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',err='';const timer=setTimeout(()=>{child.kill();reject(new Error('进程监管初始化超时'));},8000);
    child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve(out.trim()):reject(new Error(`进程监管失败：${err.trim().slice(0,800)}`));});
  });
}
export async function attachProcessJob(child, runId) {
  if(process.platform!=='win32')return null;
  if(!Number.isInteger(child.pid)||!/^[\w-]+$/.test(runId))throw new Error('无效进程监管目标');
  const owner=process.pid;
  const value=await powershell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}'; if(!$p -or $p.ParentProcessId -ne ${owner} -or !$p.CommandLine.Contains('--baodan-run=${runId}')) {throw '目标进程身份已变化'}; [BaodanJob]::Attach(${owner},${child.pid},'SuperBaodan-${runId}')`);
  if(!/^\d+$/.test(value))throw new Error('进程监管句柄无效');
  let released=false, attempted=false;
  return { async release() {
    if(released)return;const closeSource=!attempted;attempted=true;
    await powershell(`[BaodanJob]::Release(${owner},[long]${value},'SuperBaodan-${runId}',$${closeSource})`);released=true;
  } };
}
