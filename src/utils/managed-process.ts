import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { killProcessTree, POSIX_TERM_GRACE_MS } from './process-killer.js';
import { stateHome } from './task-store.js';

import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { captureCreatedAt, rememberIdentity, requireSelfIdentity, identityState, powershellPath } from './process-identity.js';

export interface ProcessResult {
  stdout: string; stderr: string; exitCode: number | null; error?: string; stopped: boolean;
}

export async function startWindowsWorker(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  // 由 Windows 创建独立 worker，避免继承客户端的进程树和 Job；环境通过内存传递。
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Error.WriteLine('AGY_MCP_WORKER_STAGE=ENVIRONMENT')
$command = [Environment]::GetEnvironmentVariable('AGY_MCP_WORKER_COMMAND', [EnvironmentVariableTarget]::Process)
$directory = [Environment]::GetEnvironmentVariable('AGY_MCP_WORKER_CWD', [EnvironmentVariableTarget]::Process)
[Console]::Error.WriteLine('AGY_MCP_WORKER_STAGE=ENVIRONMENT_CLEAR')
[Environment]::SetEnvironmentVariable('AGY_MCP_WORKER_COMMAND', $null, [EnvironmentVariableTarget]::Process)
[Environment]::SetEnvironmentVariable('AGY_MCP_WORKER_CWD', $null, [EnvironmentVariableTarget]::Process)
[Console]::Error.WriteLine('AGY_MCP_WORKER_STAGE=ENVIRONMENT_ENUMERATE')
$variables = [Environment]::GetEnvironmentVariables()
$block = [string[]]@(foreach ($key in $variables.Keys) { $key + '=' + $variables[$key] })
[Console]::Error.WriteLine('AGY_MCP_WORKER_STAGE=CIM_MODULE')
# 使用 Windows PowerShell 自带模块的明确路径，避免启动过程递归发现用户或全局模块。
Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Import-Module -Name ($PSHOME + '\Modules\CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop
[Console]::Error.WriteLine('AGY_MCP_WORKER_STAGE=CIM_STARTUP_INFO')
$startup = New-CimInstance -Namespace root/cimv2 -ClassName Win32_ProcessStartup -ClientOnly -Property @{
    ShowWindow = [uint16]0
    CreateFlags = [uint32]0x01000608
    EnvironmentVariables = $block
}
[Console]::Error.WriteLine('AGY_MCP_WORKER_STAGE=CIM_CREATE')
$created = Invoke-CimMethod -Namespace root/cimv2 -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $command
    CurrentDirectory = $directory
    ProcessStartupInformation = $startup
}
[Console]::Error.WriteLine('AGY_MCP_WORKER_STAGE=CIM_RETURN=' + $created.ReturnValue)
if ($created.ReturnValue -ne 0) { throw "WORKER_START_FAILED: Windows process creation returned $($created.ReturnValue)" }
[Console]::Error.WriteLine('AGY_MCP_WORKER_STAGE=PROCESS_IDENTITY')
$worker = [Diagnostics.Process]::GetProcessById([int]$created.ProcessId)
try {
    $handle = $worker.Handle
    [Console]::Out.Write((@{ pid = $created.ProcessId; createdAt = $worker.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() } | ConvertTo-Json -Compress))
} finally { $worker.Dispose() }
[Console]::Error.WriteLine('AGY_MCP_WORKER_STAGE=COMPLETE')`;
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 10000, maxBuffer: 8192,
      env: { ...env, AGY_MCP_WORKER_COMMAND: formatCommandLine(executable, args), AGY_MCP_WORKER_CWD: cwd }
    }));
  } catch (error) {
    const failure = error as Error & { code?: number | string | null; signal?: string | null; killed?: boolean; stderr?: string };
    const diagnostic = JSON.stringify({ code: failure.code ?? null, signal: failure.signal ?? null, killed: failure.killed ?? false });
    const message = String(error), stderr = typeof failure.stderr === 'string' ? failure.stderr.slice(-8192) : '';
    throw new Error(`WORKER_START_FAILED: ${message}\nWindows startup diagnostic: ${diagnostic}${stderr && !message.includes(stderr) ? '\n' + stderr : ''}`, { cause: error });
  }
  const identity = JSON.parse(stdout.trim()) as { pid: number; createdAt: string };
  const pid = identity.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('WORKER_START_FAILED: Windows did not return a worker PID');
  if (!/^[0-9]{1,30}$/.test(identity.createdAt)) throw new Error('WORKER_START_FAILED: Windows did not return a worker creation time');
  rememberIdentity(pid, identity.createdAt);
  return pid;
}

const LAUNCHER_CONTENT = `$ErrorActionPreference = "Stop"
Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$originalTemp = [Environment]::GetEnvironmentVariable('TEMP', [EnvironmentVariableTarget]::Process)
$originalTmp = [Environment]::GetEnvironmentVariable('TMP', [EnvironmentVariableTarget]::Process)
$compilerTemp = [IO.Path]::GetTempPath()
$encoding = [Text.Encoding]::Default
# The legacy Windows PowerShell compiler requires an ANSI-compatible temporary path.
if ($encoding.GetString($encoding.GetBytes($compilerTemp)) -cne $compilerTemp) {
    $localData = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrEmpty($localData)) { throw 'Windows PowerShell compiler temporary directory is unavailable' }
    $compilerTemp = [IO.Path]::Combine($localData, 'Temp')
    if ($encoding.GetString($encoding.GetBytes($compilerTemp)) -cne $compilerTemp) { throw 'Windows PowerShell compiler requires an ANSI-compatible temporary directory; set TEMP and TMP to a writable compatible path' }
    [void][IO.Directory]::CreateDirectory($compilerTemp)
}
try {
    [Environment]::SetEnvironmentVariable('TEMP', $compilerTemp, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable('TMP', $compilerTemp, [EnvironmentVariableTarget]::Process)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class SuspendedJobLauncher {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern bool CreateProcess(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint size, IntPtr returned);
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryLimit;
        public UIntPtr PeakJobMemoryLimit;
    }

    public static int RunInJob(string cmdLine, string cwd, int ownerPid, string ownerCreatedAt, out int childPid) {
        childPid = 0;
        IntPtr hJob = CreateJobObject(IntPtr.Zero, null);
        if (hJob == IntPtr.Zero) return -1;

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pInfo = Marshal.AllocHGlobal(length);
        Marshal.StructureToPtr(info, pInfo, false);
        bool configured = SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, pInfo, (uint)length);
        Marshal.FreeHGlobal(pInfo);
        if (!configured) { CloseHandle(hJob); throw new System.ComponentModel.Win32Exception(); }

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = 0x100;
        si.hStdInput = GetStdHandle(-10);
        si.hStdOutput = GetStdHandle(-11);
        si.hStdError = GetStdHandle(-12);
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();

        bool created = CreateProcess(null, cmdLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | 0x08000000, IntPtr.Zero, cwd, ref si, out pi);
        if (!created) {
            CloseHandle(hJob);
            return -2;
        }

        childPid = pi.dwProcessId;
        if (!AssignProcessToJobObject(hJob, pi.hProcess)) {
            TerminateProcess(pi.hProcess, 1); CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(hJob);
            throw new System.ComponentModel.Win32Exception();
        }
        if (ResumeThread(pi.hThread) == 0xFFFFFFFF) {
            TerminateJobObject(hJob, 1); CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(hJob);
            throw new System.ComponentModel.Win32Exception();
        }
        CloseHandle(pi.hThread);

        // Stop the job if its worker exits; a disconnected MCP client does not stop the worker.
        IntPtr owner = OpenProcess(0x00101000, false, ownerPid);
        if (owner == IntPtr.Zero) { TerminateJobObject(hJob, 1); CloseHandle(pi.hProcess); CloseHandle(hJob); throw new System.ComponentModel.Win32Exception(); }
        long createdAt, exitedAt, kernelTime, userTime;
        if (!GetProcessTimes(owner, out createdAt, out exitedAt, out kernelTime, out userTime) || createdAt.ToString() != ownerCreatedAt) {
            TerminateJobObject(hJob, 1); CloseHandle(owner); CloseHandle(pi.hProcess); CloseHandle(hJob); throw new Exception("Owner process identity changed");
        }
        while (WaitForSingleObject(pi.hProcess, 100) == 258) {
            if (WaitForSingleObject(owner, 0) == 0) { TerminateJobObject(hJob, 1); break; }
        }
        CloseHandle(owner);
        uint exitCode;
        GetExitCodeProcess(pi.hProcess, out exitCode);
        CloseHandle(pi.hProcess);

        if (!TerminateJobObject(hJob, 0)) { CloseHandle(hJob); throw new System.ComponentModel.Win32Exception(); }
        bool empty = false;
        for (int attempt = 0; attempt < 400; attempt++) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
            if (!QueryInformationJobObject(hJob, 1, out accounting, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) break;
            if (accounting.ActiveProcesses == 0) { empty = true; break; }
            System.Threading.Thread.Sleep(20);
        }
        if (!empty) { CloseHandle(hJob); throw new Exception("PROCESS_TERMINATION_UNCONFIRMED"); }
        CloseHandle(hJob);

        return (int)exitCode;
    }
}
"@
} finally {
    [Environment]::SetEnvironmentVariable('TEMP', $originalTemp, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable('TMP', $originalTmp, [EnvironmentVariableTarget]::Process)
}

$cmdLine = [Environment]::GetEnvironmentVariable('AGY_MCP_COMMANDLINE', [EnvironmentVariableTarget]::Process)
$cwd = [Environment]::GetEnvironmentVariable('AGY_MCP_CWD', [EnvironmentVariableTarget]::Process)
$ownerPid = [int][Environment]::GetEnvironmentVariable('AGY_MCP_OWNER_PID', [EnvironmentVariableTarget]::Process)
$ownerCreatedAt = [Environment]::GetEnvironmentVariable('AGY_MCP_OWNER_CREATED_AT', [EnvironmentVariableTarget]::Process)
[Environment]::SetEnvironmentVariable('AGY_MCP_COMMANDLINE', $null, [EnvironmentVariableTarget]::Process)
[Environment]::SetEnvironmentVariable('AGY_MCP_CWD', $null, [EnvironmentVariableTarget]::Process)
[Environment]::SetEnvironmentVariable('AGY_MCP_OWNER_PID', $null, [EnvironmentVariableTarget]::Process)
[Environment]::SetEnvironmentVariable('AGY_MCP_OWNER_CREATED_AT', $null, [EnvironmentVariableTarget]::Process)
$pidOut = 0
try {
    $code = [SuspendedJobLauncher]::RunInJob($cmdLine, $cwd, $ownerPid, $ownerCreatedAt, [ref]$pidOut)
    exit $code
} catch {
    [Console]::Error.WriteLine("AGY_MCP_JOB_FAILURE: " + $_.Exception.Message)
    exit 255
}
`;

export function formatCommandLine(executable: string, args: string[]): string {
  const parts = [executable, ...args];
  return parts.map(arg => {
    if (arg.length === 0) return '""';
    if (/[\s"\t\n\v]/.test(arg)) {
      return '"' + arg.replace(/(\\*)(")/g, '$1$1\\$2').replace(/(\\+)$/, '$1$1') + '"';
    }
    return arg;
  }).join(' ');
}

export async function runManagedProcess(executable: string, args: string[], options: {
  cwd?: string; signal?: AbortSignal; timeoutMs?: number; shell?: boolean;
  onSpawn?: (pid: number, createdAt?: string) => void; onExit?: (pid: number) => void; onOutput?: (text: string) => void;
  onStdoutChunk?: (chunk: Buffer) => void; streamingOutput?: boolean;
} = {}): Promise<ProcessResult> {
  if (options.signal?.aborted) return { stdout: '', stderr: '', exitCode: null, error: 'CANCELLED', stopped: true };

  return new Promise(resolve => {
    const env = { ...process.env };
    if (process.platform === 'win32') {
      if (!Object.keys(env).some(key => key.toLowerCase() === 'pathext' && env[key])) env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
      const pathKeys = Object.keys(env).filter(key => key.toLowerCase() === 'path');
      const inheritedPath = pathKeys.map(key => env[key]).filter(Boolean).join(path.delimiter);
      for (const key of pathKeys) delete env[key];
      env.Path = [path.dirname(process.execPath), inheritedPath, path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].filter(Boolean).join(path.delimiter);
    }
    const jobToken = process.platform === 'win32' ? undefined : crypto.randomUUID();
    if (jobToken) env.AGY_MCP_JOB_TOKEN = jobToken;
    const workingDir = options.cwd ?? process.cwd();

    let child: ReturnType<typeof spawn>;
    let createdAt: string | undefined;
    let spawnedAt = 0;

    if (process.platform === 'win32') {
      const digest = crypto.createHash('sha256').update(LAUNCHER_CONTENT).digest('hex').slice(0, 16);
      const launcherPath = path.join(stateHome(), '.gemini', 'antigravity-mcp-bin', `job-launcher-${digest}.ps1`);
      try {
        fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
        if (!fs.existsSync(launcherPath)) {
          try { fs.writeFileSync(launcherPath, LAUNCHER_CONTENT, { encoding: 'utf8', flag: 'wx' }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        }
        if (fs.lstatSync(launcherPath).isSymbolicLink() || fs.readFileSync(launcherPath, 'utf8') !== LAUNCHER_CONTENT) throw new Error('Launcher integrity mismatch');
      } catch (error) { resolve({ stdout: '', stderr: '', exitCode: null, error: `JOB_LAUNCHER_FAILED: ${String(error)}`, stopped: true }); return; }
      const shellPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
      env.AGY_MCP_COMMANDLINE = options.shell
        ? `"${shellPath}" /d /s /c "chcp 65001>nul & ${executable}"`
        : formatCommandLine(executable, args);
      env.AGY_MCP_CWD = workingDir;
      env.AGY_MCP_OWNER_PID = String(process.pid);
      env.AGY_MCP_OWNER_CREATED_AT = requireSelfIdentity();
      child = spawn(powershellPath, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherPath
      ], { cwd: workingDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      spawnedAt = Date.now();
    } else {
      child = spawn(executable, args, { cwd: options.cwd, env, shell: options.shell ?? false,
        windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    }

    let stdout = '', stderr = '', error: string | undefined, settled = false;
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let stopping: Promise<boolean> | undefined;

    const finish = (exitCode: number | null, stopped: boolean) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(stopTimer); options.signal?.removeEventListener('abort', abort);
      resolve({ stdout, stderr, exitCode, error, stopped });
    };

    const stop = (reason: string) => {
      error ??= reason;
      if (!stopping) {
        // POSIX 的 SIGTERM 宽限期计入停止期限，避免宽限期未到就判定停止未确认。
        stopTimer = setTimeout(() => { error = 'PROCESS_TERMINATION_UNCONFIRMED'; finish(null, false); },
          10000 + (process.platform === 'win32' ? 0 : POSIX_TERM_GRACE_MS));
        stopping = (async () => {
          if (child.pid === undefined) return false;
          if (process.platform === 'win32' && !createdAt) {
            // ChildProcess 持有原实例句柄；没有创建标识时不按裸 PID 杀树。
            child.kill('SIGKILL');
            return identityState(child.pid) === 'EXITED';
          }
          return (await killProcessTree(child.pid, createdAt, jobToken, { onDiagnostic: message => {
            if (!settled) {
              stderr = (stderr + '\nAGY_MCP_STOP_DIAGNOSTIC: ' + message).slice(-8192);
              if (/^[\uDC00-\uDFFF]/.test(stderr)) stderr = stderr.slice(1);
            }
          } })).verifiedTerminated;
        })().catch(() => { error = 'PROCESS_TERMINATION_UNCONFIRMED'; return false; });
      }
    };

    const abort = () => stop(typeof options.signal?.reason === 'string' ? options.signal.reason : 'CANCELLED');

    const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const text = stream === 'stdout' ? stdoutDecoder.write(buffer) : stderrDecoder.write(buffer);
      if (stream === 'stdout') {
        try { options.onStdoutChunk?.(buffer); }
        catch (callbackError) { stop('CLI_STREAM_ERROR: ' + (callbackError instanceof Error ? callbackError.message : String(callbackError))); }
      }
      const used = stdout.length;
      if (stream === 'stdout' && !options.streamingOutput) stdout += text.slice(0, Math.max(0, 5 * 1024 * 1024 - used));
      else if (stream === 'stderr') {
        const combined = stderr + text;
        if (combined.includes('AGY_MCP_JOB_FAILURE:')) error = 'PROCESS_TERMINATION_UNCONFIRMED';
        stderr = combined.slice(-8192);
        if (/^[\uDC00-\uDFFF]/.test(stderr)) stderr = stderr.slice(1);
      }
      try { options.onOutput?.(text.slice(0, 4096)); }
      catch (callbackError) { stop(`PROCESS_TRACKING_FAILED: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`); }
      if (stream === 'stdout' && !options.streamingOutput && used + text.length > 5 * 1024 * 1024) stop('OUTPUT_LIMIT_EXCEEDED');
    };

    child.stdout!.on('data', c => append('stdout', c));
    child.stderr!.on('data', c => append('stderr', c));
    child.on('error', e => { error = `SPAWN_FAILED: ${e.message}`; finish(null, true); });

    child.on('close', async code => {
      let verified = stopping ? await stopping : error !== 'PROCESS_TERMINATION_UNCONFIRMED';
      // Windows launcher owns a kill-on-close job, including detached descendants.
      if (process.platform !== 'win32') {
        if (child.pid !== undefined && !(await killProcessTree(child.pid, undefined, jobToken)).verifiedTerminated) verified = false;
      }

      if (!verified) error = 'PROCESS_TERMINATION_UNCONFIRMED';
      if (verified) {
        if (child.pid) {
          try { options.onExit?.(child.pid); } catch {}
        }
      }
      finish(code, verified);
    });

    if (child.pid) {
      createdAt = captureCreatedAt(child.pid);
      // 不登记在本次 spawn 返回以后才创建的同号进程。
      if (createdAt && BigInt(createdAt) / 10000n - 11644473600000n > BigInt(spawnedAt + 1)) createdAt = undefined;
      try { options.onSpawn?.(child.pid, createdAt); }
      catch (callbackError) { stop(`PROCESS_TRACKING_FAILED: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`); }
    }

    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    if ((options.timeoutMs ?? 0) > 0) timer = setTimeout(() => stop('TIMEOUT'), options.timeoutMs);
    child.stdin!.end();
  });
}
