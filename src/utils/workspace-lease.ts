import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalPath } from './paths.js';
import { stateHome, writeJson } from './task-store.js';
import { identityState, requireSelfIdentity } from './process-identity.js';

interface Lease { token: string; ownerPid: number; ownerCreatedAt?: string; workspace: string; taskId: string; children: number[]; childCreatedAt?: Record<string, string> }
const owned = new Map<string, { file: string; lease: Lease }>();
const root = () => path.join(stateHome(), '.gemini', 'antigravity-mcp-leases');
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
export function acquireWorkspaceLease(taskId: string, directory: string): boolean {
  const existing = owned.get(taskId);
  if (existing) {
    const requested = canonicalPath(directory);
    if (existing.lease.workspace !== (process.platform === 'win32' ? requested.toLowerCase() : requested)) throw new Error('TASK_WORKSPACE_MISMATCH');
    return true;
  }
  fs.mkdirSync(root(), { recursive: true });
  const guard = path.join(root(), 'guard');
  let fd: number;
  try { fd = fs.openSync(guard, 'wx'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    try {
      const value = JSON.parse(fs.readFileSync(guard, 'utf8')) as number | { ownerPid: number; ownerCreatedAt?: string };
      const holder = typeof value === 'number' ? { ownerPid: value } : value;
      if (holder.ownerPid > 0 && identityState(holder.ownerPid, holder.ownerCreatedAt, undefined, true) === 'EXITED') fs.unlinkSync(guard);
    } catch { /* 未写完或身份不明的 guard 不能被接管。 */ }
    return false;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ ownerPid: process.pid, ownerCreatedAt: requireSelfIdentity() }));
    const canonical = canonicalPath(directory);
    const workspace = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    for (const name of fs.readdirSync(root()).filter(n => n.endsWith('.json'))) {
      const file = path.join(root(), name);
      try {
        const lease = JSON.parse(fs.readFileSync(file, 'utf8')) as Lease;
        const children = Array.isArray(lease.children) ? lease.children : [];
        if (!Number.isSafeInteger(lease.ownerPid) || lease.ownerPid <= 0 || typeof lease.workspace !== 'string' || typeof lease.taskId !== 'string' || children.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('INVALID_LEASE');
        if (lease.ownerCreatedAt !== undefined && (typeof lease.ownerCreatedAt !== 'string' || !/^[0-9]{1,30}$/.test(lease.ownerCreatedAt))) throw new Error('INVALID_LEASE');
        if (lease.childCreatedAt !== undefined && (!lease.childCreatedAt || typeof lease.childCreatedAt !== 'object' || Array.isArray(lease.childCreatedAt)
            || Object.entries(lease.childCreatedAt).some(([pid, value]) => !/^[1-9][0-9]{0,9}$/.test(pid) || typeof value !== 'string' || !/^[0-9]{1,30}$/.test(value)))) throw new Error('INVALID_LEASE');
        if (!overlaps(workspace, lease.workspace)) continue;
        if (identityState(lease.ownerPid, lease.ownerCreatedAt, undefined, true) === 'EXITED'
            && children.every(pid => identityState(pid, lease.childCreatedAt?.[pid], undefined, true) === 'EXITED')) {
          try { fs.unlinkSync(file); } catch {}
          continue;
        }
        if (lease.taskId === taskId && lease.ownerPid === process.pid) continue;
        if (overlaps(workspace, lease.workspace)) return false;
      } catch (error) { throw new Error(`LEASE_RECORD_INVALID (${file}): ${String(error)}`); }
    }
    const token = crypto.randomUUID(), file = path.join(root(), token + '.json');
    const lease: Lease = { token, ownerPid: process.pid, ownerCreatedAt: requireSelfIdentity(), taskId, workspace, children: [], childCreatedAt: {} };
    fs.writeFileSync(file, JSON.stringify(lease), { flag: 'wx' });
    owned.set(taskId, { file, lease }); return true;
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(guard); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}
export function updateLeaseChild(taskId: string, pid: number, add: boolean, createdAt?: string): void {
  const item = owned.get(taskId); if (!item) return;
  item.lease.children = add ? [...new Set([...item.lease.children, pid])] : item.lease.children.filter(p => p !== pid);
  if (add && createdAt) (item.lease.childCreatedAt ??= {})[pid] = createdAt;
  if (!add && item.lease.childCreatedAt) delete item.lease.childCreatedAt[pid];
  writeJson(item.file, item.lease);
}
export function releaseWorkspaceLease(taskId: string): void {
  const item = owned.get(taskId); if (!item) return;
  try { fs.unlinkSync(item.file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  owned.delete(taskId);
}
export function workspaceLeaseReference(taskId: string): { file: string; token: string } {
  const item = owned.get(taskId); if (!item) throw new Error('WORKSPACE_LEASE_MISSING');
  return { file: item.file, token: item.lease.token };
}
export function handoffWorkspaceLease(taskId: string, workerPid: number, createdAt?: string): void {
  const item = owned.get(taskId); if (!item || !Number.isSafeInteger(workerPid) || workerPid <= 0) throw new Error('WORKSPACE_LEASE_MISSING');
  if (identityState(workerPid, createdAt, undefined, true) !== 'ALIVE') throw new Error('PROCESS_IDENTITY_UNAVAILABLE: worker identity could not be confirmed');
  item.lease.ownerPid = workerPid; item.lease.ownerCreatedAt = createdAt; writeJson(item.file, item.lease); owned.delete(taskId);
}
export function adoptWorkspaceLease(taskId: string, directory: string, reference: { file: string; token: string }): void {
  if (path.resolve(reference.file) !== path.resolve(root(), reference.token + '.json')) throw new Error('WORKSPACE_LEASE_INVALID');
  const lease = JSON.parse(fs.readFileSync(reference.file, 'utf8')) as Lease;
  const canonical = canonicalPath(directory), workspace = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  if (lease.token !== reference.token || lease.taskId !== taskId || lease.ownerPid !== process.pid || lease.workspace !== workspace
      || identityState(process.pid, lease.ownerCreatedAt) !== 'ALIVE') throw new Error('WORKSPACE_LEASE_BINDING_INVALID');
  owned.set(taskId, { file: reference.file, lease });
}
