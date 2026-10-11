import test from 'node:test';
import assert from 'node:assert/strict';
import { terminatePosixTargets } from '../src/utils/process-killer.js';

test('POSIX grace keeps TERM before KILL and only forces surviving targets on every platform', async () => {
  let now = 0;
  const alive = new Set([11, 12]), signals: { pid: number; name: string; at: number }[] = [];
  const result = await terminatePosixTargets([11, 12, 11], {
    now: () => now, sleep: async ms => { now += ms; }, isAlive: pid => alive.has(pid),
    signal: (pid, name) => {
      signals.push({ pid, name, at: now });
      if (pid === 11 || name === 'SIGKILL') alive.delete(pid);
    }
  });
  assert.deepEqual(result, { success: true, verifiedTerminated: true });
  assert.deepEqual(signals, [
    { pid: 11, name: 'SIGTERM', at: 0 }, { pid: 12, name: 'SIGTERM', at: 0 },
    { pid: 12, name: 'SIGKILL', at: 5000 }
  ]);
});

test('graceful POSIX completion needs no KILL or grace sleep', async () => {
  let alive = true;
  const signals: string[] = [];
  const result = await terminatePosixTargets([11], {
    now: () => 0, isAlive: () => alive, sleep: async () => assert.fail('graceful exit must not sleep'),
    signal: (_pid, name) => { signals.push(name); alive = false; }
  });
  assert.deepEqual(result, { success: true, verifiedTerminated: true });
  assert.deepEqual(signals, ['SIGTERM']);
});

test('failed POSIX signals never become verified termination', async () => {
  let now = 0;
  const signals: string[] = [];
  const result = await terminatePosixTargets([11], {
    termGraceMs: 200, now: () => now, sleep: async ms => { now += ms; }, isAlive: () => true,
    signal: (_pid, name) => { signals.push(name); throw new Error('permission denied'); }
  });
  assert.deepEqual(result, { success: false, verifiedTerminated: false });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(now, 8200, 'the failed stop must still exhaust verification after the grace period');
});

test('already exited POSIX targets do not receive signals', async () => {
  assert.deepEqual(await terminatePosixTargets([11], {
    isAlive: () => false, signal: () => assert.fail('an exited process must not be signalled'),
    sleep: async () => assert.fail('no targets remain')
  }), { success: true, verifiedTerminated: true });
});
