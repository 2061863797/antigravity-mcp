import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../.verify-out/', import.meta.url));
fs.mkdirSync(directory, { recursive: true });
const root = fs.mkdtempSync(path.join(directory, 'agy-stop-retry-'));
const originalHome = process.env.ANTIGRAVITY_MCP_STATE_HOME;
process.env.ANTIGRAVITY_MCP_STATE_HOME = root;
let enumerationFailed = false;
const originalExec = childProcess.execFile;
const exec = (...args: Parameters<typeof originalExec>) => originalExec(...args);
Object.defineProperty(exec, promisify.custom, { value: async (file: string) => {
  assert.equal(file, 'ps');
  if (enumerationFailed) throw new Error('injected ps enumeration failure');
  return { stdout: 'PID PPID\n', stderr: '' };
} });
childProcess.execFile = exec as typeof originalExec;
syncBuiltinESMExports();
const { TaskTracker } = await import('../src/utils/task-tracker.js');
const { readTask, writeJson } = await import('../src/utils/task-store.js');
const { acquireWorkspaceLease, releaseWorkspaceLease, workspaceLeaseReference, updateLeaseChild } = await import('../src/utils/workspace-lease.js');
const { killProcessTree } = await import('../src/utils/process-killer.js');
childProcess.execFile = originalExec;
syncBuiltinESMExports();
test.after(() => {
  if (originalHome === undefined) delete process.env.ANTIGRAVITY_MCP_STATE_HOME; else process.env.ANTIGRAVITY_MCP_STATE_HOME = originalHome;
  assert.equal(path.dirname(root), directory.replace(/[\\/]$/, ''));
  assert(path.basename(root).startsWith('agy-stop-retry-'));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(t: TestContext, name: string, withToken = true) {
  const workspace = path.join(root, name); fs.mkdirSync(workspace);
  const id = 'task_' + name, token = withToken ? crypto.randomUUID() : undefined;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', originalPlatform));
  const dead = process.pid + 100, escaped = process.pid + 101;
  let alive = true, scanFailed = false;
  const signals: { pid: number; name: string }[] = [];
  t.mock.method(process, 'kill', (pid: number, signal: string | number = 0) => {
    if (pid === process.pid && signal === 0) return true;
    if (pid !== escaped || !alive) throw Object.assign(new Error('exited'), { code: 'ESRCH' });
    if (signal !== 0) { signals.push({ pid, name: String(signal) }); alive = false; }
    return true;
  });
  const entries = () => {
    if (scanFailed) throw Object.assign(new Error('procfs unreadable'), { code: 'EACCES' });
    return [String(dead), String(escaped)];
  };
  const environment = (file: string) => {
    if (!alive || Number(file.split('/')[2]) !== escaped) throw Object.assign(new Error('exited'), { code: 'ENOENT' });
    return Buffer.from(`PATH=/bin\0AGY_MCP_JOB_TOKEN=${token}\0`);
  };
  const read = fs.readFileSync, list = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (file: fs.PathLike, ...args: unknown[]) => String(file) === '/proc' ? entries() : (list as Function)(file, ...args));
  t.mock.method(fs, 'readFileSync', (file: fs.PathOrFileDescriptor, ...args: unknown[]) => String(file).startsWith('/proc/') ? environment(String(file)) : (read as Function)(file, ...args));
  t.mock.method(fs.promises, 'readdir', async (file: string) => { assert.equal(file, '/proc'); return entries(); });
  t.mock.method(fs.promises, 'readFile', async (file: string) => environment(file));
  assert.equal(acquireWorkspaceLease(id, workspace, token), true);
  const lease = workspaceLeaseReference(id), tracker = new TaskTracker();
  const task = tracker.create({ taskId: id, workspaceDir: workspace }, token);
  task.lease = lease; task.completion = Promise.resolve();
  tracker.trackPid(task, dead, true); updateLeaseChild(id, dead, true);
  tracker.update(task, { executionStarted: true, currentPhase: 'STOPPING', response: 'kept partial',
    errorCode: 'PROCESS_TERMINATION_UNCONFIRMED', executionStatus: 'PROCESS_TERMINATION_UNCONFIRMED' });
  tracker.persist(task, true);
  t.after(() => { tracker.persist(task, true); releaseWorkspaceLease(id); });
  return { id, token, dead, escaped, task, tracker, workspace, lease, signals,
    setScanFailed: (value: boolean) => { scanFailed = value; }, stopEscaped: () => { alive = false; } };
}

test('cancellation retry finds an escaped descendant after the tracked root has exited', async t => {
  const f = fixture(t, 'retry');
  assert.equal(readTask(f.id)!.posixJobToken, f.token);
  assert.equal(JSON.parse(fs.readFileSync(f.lease.file, 'utf8')).posixJobToken, f.token);
  assert.equal((await f.tracker.cancel(f.id))!.result.status, 'CANCELLED');
  assert.deepEqual(f.signals, [{ pid: f.escaped, name: 'SIGTERM' }]);
  assert.equal(f.task.result.response, 'kept partial');
  assert(!fs.existsSync(f.lease.file));
  assert(!('posixJobToken' in f.task.result), 'the private cleanup token is not an MCP output field');
});

test('an unreadable procfs keeps cancellation and the lease unconfirmed until an explicit retry', async t => {
  const f = fixture(t, 'unreadable'); f.setScanFailed(true);
  assert.equal((await f.tracker.cancel(f.id))!.result.status, 'RUNNING');
  assert.equal(f.task.result.errorCode, 'PROCESS_TERMINATION_UNCONFIRMED');
  assert.deepEqual(f.signals, []); assert(fs.existsSync(f.lease.file));
  assert.equal(acquireWorkspaceLease('blocked_contender', f.workspace), false);
  f.setScanFailed(false);
  assert.equal((await f.tracker.cancel(f.id))!.result.status, 'CANCELLED');
  assert(!fs.existsSync(f.lease.file));
});

test('a dead worker cannot make escaped descendants disappear from status or allow lease takeover', t => {
  const f = fixture(t, 'dead_worker');
  f.task.ownerPid = f.dead; f.task.workerPid = f.dead; f.tracker.persist(f.task, true);
  const lease = JSON.parse(fs.readFileSync(f.lease.file, 'utf8')); lease.ownerPid = f.dead; writeJson(f.lease.file, lease);
  const observer = new TaskTracker();
  assert.equal(observer.get(f.id)!.result.status, 'RUNNING');
  assert.equal(observer.get(f.id)!.result.errorCode, 'PROCESS_TERMINATION_UNCONFIRMED');
  assert.equal(acquireWorkspaceLease('dead_worker_contender', f.workspace), false);
  f.setScanFailed(true);
  assert.equal(observer.get(f.id)!.result.status, 'RUNNING');
  assert.equal(acquireWorkspaceLease('unreadable_contender', f.workspace), false);
  f.setScanFailed(false); f.stopEscaped();
  assert.equal(observer.get(f.id)!.result.errorCode, 'WORKER_INTERRUPTED');
  assert.equal(acquireWorkspaceLease('verified_contender', f.workspace), true);
  releaseWorkspaceLease('verified_contender');
});

test('a legacy Linux record with no cleanup token cannot certify cancellation', async t => {
  const f = fixture(t, 'legacy', false);
  assert(!('posixJobToken' in JSON.parse(fs.readFileSync(f.lease.file, 'utf8'))));
  assert.equal((await f.tracker.cancel(f.id))!.result.status, 'RUNNING');
  assert.match(f.task.result.errorMessage!, /人工核对/);
  assert(fs.existsSync(f.lease.file)); assert.deepEqual(f.signals, []);
});

test('ps enumeration failure still stops token-matched descendants while keeping verification conservative', async t => {
  const f = fixture(t, 'ps_failure'); enumerationFailed = true;
  t.after(() => { enumerationFailed = false; });
  assert.deepEqual(await killProcessTree(f.dead, undefined, f.token, { termGraceMs: 0 }), { success: true, verifiedTerminated: false });
  assert.deepEqual(f.signals, [{ pid: f.escaped, name: 'SIGTERM' }]);
  assert(fs.existsSync(f.lease.file));
});

test('a reused root PID without this token is not signalled and cannot release the lease', async t => {
  const f = fixture(t, 'reused_root'); f.stopEscaped();
  const calls: { pid: number; signal: string | number }[] = [];
  t.mock.method(process, 'kill', (pid: number, signal: string | number = 0) => {
    calls.push({ pid, signal });
    assert.equal(signal, 0, 'an unrelated process must only be observed');
    if (pid === process.pid || pid === f.dead) return true;
    throw Object.assign(new Error('exited'), { code: 'ESRCH' });
  });
  assert.equal((await f.tracker.cancel(f.id))!.result.status, 'RUNNING');
  assert.equal(f.task.result.errorCode, 'PROCESS_TERMINATION_UNCONFIRMED');
  assert(calls.some(call => call.pid === f.dead));
  assert(calls.every(call => call.signal === 0));
  assert(fs.existsSync(f.lease.file));
});
