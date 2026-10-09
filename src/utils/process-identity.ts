import childProcess from 'node:child_process';
import path from 'node:path';

export type IdentityState = 'ALIVE' | 'EXITED' | 'UNKNOWN';
export const powershellPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cache = new Map<number, { createdAt?: string; checkedAt: number }>();
let selfCreatedAt: string | undefined;
export function pidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export function rememberIdentity(pid: number, createdAt?: string): void {
  cache.delete(pid); cache.set(pid, { createdAt, checkedAt: Date.now() });
  if (cache.size > 1024) cache.delete(cache.keys().next().value!);
  if (pid === process.pid && createdAt) selfCreatedAt = createdAt;
}
export function captureCreatedAt(pid: number): string | undefined {
  if (process.platform !== 'win32' || !pidExists(pid)) return undefined;
  if (pid === process.pid && selfCreatedAt) return selfCreatedAt;
  let createdAt: string | undefined;
  try {
    const output = childProcess.execFileSync(powershellPath, ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById([int]$env:AGY_IDENTITY_PID);try{$handle=$p.Handle;[Console]::Out.Write($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString())}finally{$p.Dispose()}"],
    { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, AGY_IDENTITY_PID: String(pid) } }).trim();
    if (/^[0-9]{1,30}$/.test(output)) createdAt = output;
  } catch { /* 存活但无法取得创建标识时，必须保持 UNKNOWN。 */ }
  rememberIdentity(pid, createdAt);
  return createdAt;
}
export function knownCreatedAt(pid: number): string | undefined {
  return cache.get(pid)?.createdAt ?? captureCreatedAt(pid);
}
export function requireSelfIdentity(): string | undefined {
  const createdAt = knownCreatedAt(process.pid);
  if (process.platform === 'win32' && !createdAt) throw new Error('PROCESS_IDENTITY_UNAVAILABLE: cannot read this process creation time');
  return createdAt;
}
export function identityState(pid: number, expected?: string, heartbeatAt?: number, force = false): IdentityState {
  if (!pidExists(pid)) { cache.delete(pid); return 'EXITED'; }
  if (process.platform !== 'win32') return 'ALIVE';
  if (!expected) return 'UNKNOWN';
  if (pid === process.pid && selfCreatedAt) return selfCreatedAt === expected ? 'ALIVE' : 'EXITED';
  const entry = cache.get(pid);
  // 只有此前已经核对的实例，才可利用原 worker 的新心跳省去重复系统查询。
  const heartbeatAge = heartbeatAt === undefined ? Infinity : Date.now() - heartbeatAt;
  const freshHeartbeat = entry?.createdAt === expected && heartbeatAge >= 0 && heartbeatAge <= 3000;
  const cacheAge = entry ? Date.now() - entry.checkedAt : Infinity;
  const current = !force && entry && (freshHeartbeat || cacheAge >= 0 && cacheAge < 1000)
    ? entry.createdAt : captureCreatedAt(pid);
  if (!current) return pidExists(pid) ? 'UNKNOWN' : 'EXITED';
  return current === expected ? 'ALIVE' : 'EXITED';
}
