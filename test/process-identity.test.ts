import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess, { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const temporary = os.tmpdir(), suite = fs.mkdtempSync(path.join(temporary, 'antigravity-identity-'));
process.env.ANTIGRAVITY_MCP_STATE_HOME = suite;
const { captureCreatedAt, identityState, requireSelfIdentity } = await import('../src/utils/process-identity.js');
const { TaskTracker } = await import('../src/utils/task-tracker.js');
const { saveTask, readTask, taskFile, writeJson } = await import('../src/utils/task-store.js');
const { normalizeResult } = await import('../src/utils/register-tool.js');
const { acquireWorkspaceLease, releaseWorkspaceLease } = await import('../src/utils/workspace-lease.js');
const { killProcessTree, isProcessAlive } = await import('../src/utils/process-killer.js');
const leases = path.join(suite, '.gemini', 'antigravity-mcp-leases');
const fixture = (name: string) => { const directory = path.join(suite, name); fs.mkdirSync(directory); return directory; };
const record = (id: string, workspace: string, pid = process.pid, createdAt = requireSelfIdentity()) => {
  const startedAt = Date.now() - 3600000;
  return { version: 1 as const, result: normalizeResult({ taskId: id, workspaceDir: workspace, executionWorkspaceDir: workspace,
    status: 'RUNNING', executionStatus: 'RUNNING', currentPhase: 'CODING', executionStarted: true, elapsedSeconds: 7,
    startedAt: new Date(startedAt).toISOString(), lastObservedAt: new Date(startedAt + 7000).toISOString() }),
  startedAt, ownerPid: pid, workerPid: pid, ownerCreatedAt: createdAt, workerCreatedAt: createdAt,
  childPids: [], childCreatedAt: {}, token: crypto.randomUUID(), ready: true, heartbeatAt: startedAt + 7000, lease: null };
};
const lease = (id: string, workspace: string, pid: number, createdAt?: string) => {
  const token = crypto.randomUUID(), file = path.join(leases, token + '.json');
  writeJson(file, { token, taskId: id, workspace: workspace.toLowerCase(), ownerPid: pid, ownerCreatedAt: createdAt, children: [], childCreatedAt: {} });
  return file;
};
const sleeper = async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return child;
};
const stop = async (child: ReturnType<typeof spawn>) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
};
after(() => {
  assert.equal(path.dirname(path.resolve(suite)), path.resolve(temporary));
  assert(path.basename(suite).startsWith('antigravity-identity-'));
  fs.rmSync(suite, { recursive: true, force: true });
});

test('reused owner PID ends the old task at its saved elapsed time and allows directory reuse', { skip: process.platform !== 'win32' }, () => {
  const workspace = fixture('reused-owner'), wrong = String(BigInt(requireSelfIdentity()!) + 1n);
  saveTask(record('reused-owner', workspace, process.pid, wrong));
  lease('reused-owner', workspace, process.pid, wrong);
  const tracker = new TaskTracker(), task = tracker.get('reused-owner')!;
  assert.equal(task.result.status, 'ERROR'); assert.equal(task.result.errorCode, 'WORKER_INTERRUPTED');
  assert.equal(tracker.report(task).elapsedSeconds, 7); assert.equal(identityState(process.pid, wrong), 'EXITED');
  assert.equal(acquireWorkspaceLease('reused-successor', workspace), true); releaseWorkspaceLease('reused-successor');
});
test('mismatched native process identity never kills the new process', { skip: process.platform !== 'win32' }, async () => {
  const child = await sleeper();
  try {
    const stamp = captureCreatedAt(child.pid!)!; assert(stamp);
    const wrong = await killProcessTree(child.pid!, String(BigInt(stamp) + 1n));
    assert.equal(wrong.verifiedTerminated, true); assert.equal(await isProcessAlive(child.pid!), true);
    const correct = await killProcessTree(child.pid!, stamp);
    assert.equal(correct.verifiedTerminated, true); assert.equal(await isProcessAlive(child.pid!), false);
  } finally { await stop(child); }
});
for (const mode of ['missing', 'mismatch']) {
  test(`CIM root ${mode} keeps cancellation unconfirmed and the lease held until a verified retry`, { skip: process.platform !== 'win32' }, async () => {
    const state = fixture('cim-' + mode), workspace = path.join(state, 'workspace');
    const { stdout } = await promisify(childProcess.execFile)(process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./fixtures/cim-enumeration-fault.mjs', import.meta.url)), mode, workspace],
      { windowsHide: true, timeout: 60000, maxBuffer: 65536, env: { ...process.env, ANTIGRAVITY_MCP_STATE_HOME: state } });
    const value = JSON.parse(stdout) as { mode: string; duringFault: { native: { success: boolean; verifiedTerminated: boolean }; aliveAfterNative: boolean;
      cancellationStatus: string; errorCode: string; managedProcess: string; aliveAfterCancel: boolean; leaseBlocked: boolean; injectedQueries: number };
      afterRecovery: { status: string; alive: boolean; leaseAvailable: boolean } };
    assert.equal(value.mode, mode); assert.equal(value.duringFault.injectedQueries, 2);
    assert.deepEqual(value.duringFault.native, { success: false, verifiedTerminated: false });
    assert.equal(value.duringFault.aliveAfterNative, true); assert.equal(value.duringFault.aliveAfterCancel, true);
    assert.equal(value.duringFault.cancellationStatus, 'RUNNING'); assert.equal(value.duringFault.errorCode, 'PROCESS_TERMINATION_UNCONFIRMED');
    assert.equal(value.duringFault.managedProcess, 'UNKNOWN'); assert.equal(value.duringFault.leaseBlocked, true);
    assert.deepEqual(value.afterRecovery, { status: 'CANCELLED', alive: false, leaseAvailable: true });
  });
}
test('identity read failure remains unknown, freezes elapsed time and holds the lease without killing', { skip: process.platform !== 'win32' }, async () => {
  const workspace = fixture('unknown-owner'), child = await sleeper(), original = childProcess.execFileSync;
  let file: string | undefined;
  try {
    const stamp = captureCreatedAt(child.pid!)!; assert(stamp); requireSelfIdentity();
    saveTask(record('unknown-owner', workspace, child.pid!, stamp)); file = lease('unknown-owner', workspace, child.pid!, stamp);
    const bytes = fs.readFileSync(taskFile('unknown-owner'), 'utf8');
    childProcess.execFileSync = (() => { throw Object.assign(new Error('identity denied'), { code: 'EACCES' }); }) as typeof childProcess.execFileSync;
    assert.equal(identityState(child.pid!, stamp, undefined, true), 'UNKNOWN');
    const tracker = new TaskTracker(), task = tracker.get('unknown-owner')!, report = tracker.report(task);
    assert.equal(report.status, 'RUNNING'); assert.equal(report.errorCode, 'PROCESS_TERMINATION_UNCONFIRMED');
    assert.equal(report.managedProcess, 'UNKNOWN'); assert.equal(report.elapsedSeconds, 7);
    assert.equal(fs.readFileSync(taskFile('unknown-owner'), 'utf8'), bytes);
    assert.equal(acquireWorkspaceLease('unknown-contender', workspace), false); assert(fs.existsSync(file));
    assert.equal((await killProcessTree(child.pid!, stamp)).verifiedTerminated, false); assert.equal(await isProcessAlive(child.pid!), true);
  } finally { childProcess.execFileSync = original; await stop(child); if (file && fs.existsSync(file)) fs.unlinkSync(file); }
});
test('fresh worker heartbeats reuse a confirmed identity without spawning probes on every poll', { skip: process.platform !== 'win32' }, async () => {
  const workspace = fixture('healthy-owner'), child = await sleeper(), original = childProcess.execFileSync;
  try {
    const stamp = captureCreatedAt(child.pid!)!; assert(stamp);
    const saved = record('healthy-owner', workspace, child.pid!, stamp); saved.heartbeatAt = Date.now(); saveTask(saved);
    let probes = 0;
    childProcess.execFileSync = ((...args: Parameters<typeof childProcess.execFileSync>) => { probes++; return original(...args); }) as typeof childProcess.execFileSync;
    const tracker = new TaskTracker();
    for (let count = 0; count < 30; count++) assert.equal(tracker.report(tracker.get('healthy-owner')!).errorCode, null);
    assert.equal(probes, 0);
  } finally { childProcess.execFileSync = original; await stop(child); }
});
test('legacy active records retain their bytes and use the original worker control channel', { skip: process.platform !== 'win32' }, async () => {
  const workspace = fixture('legacy-active'), id = 'legacy-active', child = spawn(process.execPath, ['-e',
    "const fs=require('fs');const task=process.argv[1],control=process.argv[2];setInterval(()=>{if(!fs.existsSync(control)||!fs.existsSync(task))return;const record=JSON.parse(fs.readFileSync(task)),request=JSON.parse(fs.readFileSync(control));if(request.token!==record.token)return;record.result.status='CANCELLED';record.result.executionStatus='CANCELLED';record.result.errorCode='CANCELLED';record.result.revision++;record.result.currentPhase='IDLE';fs.writeFileSync(task+'.tmp',JSON.stringify(record));fs.renameSync(task+'.tmp',task);process.exit(0)},20);",
    taskFile(id), taskFile(id, 'cancel')], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try {
    const saved = record(id, workspace, child.pid!);
    delete saved.ownerCreatedAt; delete saved.workerCreatedAt;
    const legacy: Record<string, unknown> = { ...saved }; delete legacy.childCreatedAt; saveTask(legacy as unknown as Parameters<typeof saveTask>[0]);
    const bytes = fs.readFileSync(taskFile(id), 'utf8'), tracker = new TaskTracker(), before = tracker.get(id)!;
    assert.equal(before.result.status, 'RUNNING'); assert.equal(tracker.report(before).managedProcess, 'UNKNOWN');
    assert.equal(fs.readFileSync(taskFile(id), 'utf8'), bytes);
    const cancelled = await tracker.cancel(id);
    assert.equal(cancelled?.result.status, 'CANCELLED'); assert.equal(readTask(id)?.result.status, 'CANCELLED');
  } finally { await stop(child); }
});
