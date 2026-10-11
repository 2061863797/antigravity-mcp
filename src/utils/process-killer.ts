import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureCreatedAt, identityState, pidExists, powershellPath } from './process-identity.js';
const run = promisify(execFile);

export async function isProcessAlive(pid: number): Promise<boolean> {
  return pidExists(pid);
}

// 仅 POSIX 使用：Windows 由 killWindowsTree 按 CIM 父子关系和创建标识处理。
async function findDescendantPids(rootPid: number): Promise<number[]> {
  try {
    const parentMap = new Map<number, number[]>();
    for (const line of (await run('ps', ['-eo', 'pid,ppid'])).stdout.trim().split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(value => parseInt(value, 10));
      if (Number.isSafeInteger(pid) && Number.isSafeInteger(ppid)) parentMap.set(ppid, [...parentMap.get(ppid) ?? [], pid]);
    }
    const descendants = new Set<number>(), queue = [rootPid];
    while (queue.length) {
      for (const child of parentMap.get(queue.shift()!) ?? []) {
        if (!descendants.has(child)) { descendants.add(child); queue.push(child); }
      }
    }
    return [...descendants];
  } catch (err) {
    throw new Error(`Process enumeration failed: ${String(err)}`);
  }
}

// Linux：环境变量会跨 setsid / 重新认父继承，可据此找到已脱离进程树的逃逸后代。
export async function findPidsByEnvToken(token: string): Promise<number[]> {
  if (process.platform !== 'linux') return [];
  const needle = Buffer.from('AGY_MCP_JOB_TOKEN=' + token + '\0');
  const delimited = Buffer.concat([Buffer.from([0]), needle]);
  const found: number[] = [];
  for (const name of await fs.promises.readdir('/proc').catch(() => [] as string[])) {
    if (!/^[1-9][0-9]*$/.test(name) || Number(name) === process.pid) continue;
    try {
      const environment = await fs.promises.readFile('/proc/' + name + '/environ');
      if (environment.subarray(0, needle.length).equals(needle) || environment.includes(delimited)) found.push(Number(name));
    } catch { /* 已退出或无权读取 */ }
  }
  return found;
}

// POSIX 先发 SIGTERM 让 agy 收尾，宽限期后仍存活的再 SIGKILL；Windows 仍由 Job Object 硬杀。
export const POSIX_TERM_GRACE_MS = 5000;

export async function killProcessTree(pid: number, expectedCreatedAt?: string, jobToken?: string, options: {
  onDiagnostic?: (message: string) => void; termGraceMs?: number
} = {}): Promise<{ success: boolean; verifiedTerminated: boolean }> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { success: false, verifiedTerminated: false };
  if (process.platform === 'win32') {
    const expected = expectedCreatedAt ?? captureCreatedAt(pid, options.onDiagnostic);
    const state = identityState(pid, expected, undefined, true, options.onDiagnostic);
    if (state === 'EXITED') return { success: true, verifiedTerminated: true };
    if (state !== 'ALIVE' || !expected) {
      options.onDiagnostic?.('Windows stop identity state: ' + state);
      return { success: false, verifiedTerminated: false };
    }
    return killWindowsTree(pid, expected, options.onDiagnostic);
  }
  let descendants: number[] = [];
  try {
    descendants = await findDescendantPids(pid);
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    return { success: false, verifiedTerminated: false };
  }
  const escaped = jobToken ? await findPidsByEnvToken(jobToken) : [];
  const targets = [...new Set([pid, ...descendants, ...escaped])];
  let success = false;
  const signal = async (name: NodeJS.Signals) => {
    for (const target of targets) {
      if (!await isProcessAlive(target)) continue;
      try {
        process.kill(target, name);
        success = true;
      } catch { /* Verification remains conservative on permission/command errors. */ }
    }
  };
  await signal('SIGTERM');
  const graceEnd = Date.now() + Math.max(0, options.termGraceMs ?? POSIX_TERM_GRACE_MS);
  while (Date.now() < graceEnd && (await Promise.all(targets.map(isProcessAlive))).some(Boolean)) {
    await new Promise(r => setTimeout(r, 100));
  }
  await signal('SIGKILL');
  for (let i = 0; i < 32; i++) {
    const alive = await Promise.all(targets.map(isProcessAlive));
    if (alive.every(isAlive => !isAlive)) return { success: true, verifiedTerminated: true };
    await new Promise(r => setTimeout(r, 250));
  }
  return { success, verifiedTerminated: false };
}
async function killWindowsTree(pid: number, expected: string, onDiagnostic?: (message: string) => void): Promise<{ success: boolean; verifiedTerminated: boolean }> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('AGY_MCP_STOP_STAGE=ROOT_IDENTITY')
$handles = [Collections.Generic.List[Diagnostics.Process]]::new()
$verified = $true
try {
  try { $root = [Diagnostics.Process]::GetProcessById([int]$env:AGY_STOP_PID) }
  catch [ArgumentException] { [Console]::Out.Write('{"success":true,"verifiedTerminated":true}'); exit }
  $handles.Add($root)
  $handle = $root.Handle
  if ($root.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $env:AGY_STOP_CREATED_AT) {
    [Console]::Out.Write('{"success":true,"verifiedTerminated":true}'); exit
  }
  [Console]::Error.WriteLine('AGY_MCP_STOP_STAGE=CIM_MODULE')
  Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
  Import-Module -Name ($PSHOME + '\Modules\CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop
  [Console]::Error.WriteLine('AGY_MCP_STOP_STAGE=CIM_ENUMERATION')
  $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)
  $rootRow = $rows | Where-Object { $_.ProcessId -eq $root.Id } | Select-Object -First 1
  $rootTime = $root.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ')
  if (-not $rootRow -or $rootRow.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -ne $rootTime) {
    [Console]::Error.WriteLine('AGY_MCP_STOP_STAGE=CIM_ROOT_UNCONFIRMED')
    # 枚举缺项或信息不一致不能证明原实例已停止，保留未确认状态。
    [Console]::Out.Write('{"success":false,"verifiedTerminated":false}'); exit
  }
  [Console]::Error.WriteLine('AGY_MCP_STOP_STAGE=DESCENDANT_IDENTITIES')
  $selected = [Collections.Generic.List[object]]::new()
  $selected.Add($rootRow)
  for ($i=0; $i -lt $selected.Count; $i++) {
    $parent = $selected[$i]
    foreach ($row in $rows) {
      if ($row.ParentProcessId -eq $parent.ProcessId -and $row.CreationDate -ge $parent.CreationDate -and
          -not ($selected | Where-Object { $_.ProcessId -eq $row.ProcessId })) { $selected.Add($row) }
    }
  }
  foreach ($row in $selected | Select-Object -Skip 1) {
    $process = $null
    try {
      $process = [Diagnostics.Process]::GetProcessById([int]$row.ProcessId)
      $handle = $process.Handle
      if ($process.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -ne
          $row.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ')) { $process.Dispose(); continue }
      $handles.Add($process)
    } catch [ArgumentException] { if ($process) { $process.Dispose() } }
      catch { if ($process) { $process.Dispose() }; $verified = $false }
  }
  [Console]::Error.WriteLine('AGY_MCP_STOP_STAGE=TERMINATION')
  foreach ($process in $handles) {
    try { if (-not $process.HasExited) { $process.Kill() }; if (-not $process.WaitForExit(8000)) { $verified = $false } }
    catch { $verified = $false }
  }
  [Console]::Error.WriteLine('AGY_MCP_STOP_STAGE=COMPLETE;VERIFIED=' + $verified)
  [Console]::Out.Write((@{ success=$verified; verifiedTerminated=$verified } | ConvertTo-Json -Compress))
} finally { foreach ($process in $handles) { $process.Dispose() } }`;
  try {
    onDiagnostic?.('Windows stop command started: ' + pid);
    const command = run(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10000, maxBuffer: 8192, env: { ...process.env, AGY_STOP_PID: String(pid), AGY_STOP_CREATED_AT: expected } });
    if (onDiagnostic) command.child?.stderr?.on('data', chunk => {
      try { onDiagnostic(String(chunk).slice(-8192)); } catch { /* 诊断观察者不能中断安全停止。 */ }
    });
    const { stdout, stderr } = await command;
    const value = JSON.parse(stdout.trim()) as { success?: boolean; verifiedTerminated?: boolean };
    if (value.verifiedTerminated !== true) onDiagnostic?.('Windows stop unconfirmed: ' + stderr.slice(-8192));
    return { success: value.success === true, verifiedTerminated: value.verifiedTerminated === true };
  } catch (error) {
    onDiagnostic?.('Windows stop command failed: ' + String(error));
    return { success: false, verifiedTerminated: false };
  }
}
