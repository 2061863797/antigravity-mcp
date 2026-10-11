import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { findPidsByEnvToken, killProcessTree, POSIX_TERM_GRACE_MS } from '../src/utils/process-killer.js';

test('Linux environment token finds tagged processes without selecting untagged processes', {
  skip: process.platform !== 'linux' ? '实际 /proc 环境扫描仅适用于 Linux' : false,
  timeout: 10000
}, async t => {
  const token = crypto.randomUUID(), environment = { ...process.env };
  delete environment.AGY_MCP_JOB_TOKEN;
  const children = [
    spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], {
      env: { ...environment, AGY_MCP_JOB_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    }),
    spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], {
      env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    })
  ];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }));
  });
  await Promise.all(children.map(child => once(child.stdout!, 'data')));
  const found = await findPidsByEnvToken(token);
  assert(found.includes(children[0].pid!));
  assert(!found.includes(children[1].pid!));
  assert(!found.includes(process.pid));
  assert(!(await findPidsByEnvToken(token.slice(0, -1))).includes(children[0].pid!));
});

test('POSIX stop sends SIGTERM first and SIGKILLs only processes that outlive the grace period', {
  skip: process.platform === 'win32' ? 'Windows 由 Job Object 直接终止，不使用 POSIX 信号宽限期' : false,
  timeout: 20000
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-term-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL('./fixtures/term-child.mjs', import.meta.url));
  const start = (mode: string) => {
    const marker = path.join(directory, mode + '.marker');
    const child = spawn(process.execPath, [fixture, mode, marker], { stdio: ['ignore', 'pipe', 'ignore'] });
    return { child, marker, closed: once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]> };
  };
  const graceful = start('graceful'), ignoring = start('ignore');
  t.after(() => { for (const { child } of [graceful, ignoring]) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await Promise.all([graceful, ignoring].map(({ child }) => once(child.stdout!, 'data')));

  const gracefulStop = await killProcessTree(graceful.child.pid!, undefined, undefined, { termGraceMs: 3000 });
  assert.deepEqual(gracefulStop, { success: true, verifiedTerminated: true });
  assert.deepEqual(await graceful.closed, [0, null]);
  assert.equal(fs.readFileSync(graceful.marker, 'utf8'), 'SIGTERM');

  const began = Date.now();
  const forcedStop = await killProcessTree(ignoring.child.pid!, undefined, undefined, { termGraceMs: 300 });
  assert.deepEqual(forcedStop, { success: true, verifiedTerminated: true });
  assert.deepEqual(await ignoring.closed, [null, 'SIGKILL']);
  assert(Date.now() - began >= 300, 'SIGKILL must wait for the injected grace period');
  assert(!fs.existsSync(ignoring.marker));
});

test('POSIX grace period defaults to five seconds', () => {
  assert.equal(POSIX_TERM_GRACE_MS, 5000);
});

test('environment token lookup returns empty on platforms without Linux procfs', {
  skip: process.platform === 'linux' ? 'Linux 使用上面的真实 /proc 扫描测试' : false
}, async () => {
  assert.deepEqual(await findPidsByEnvToken(crypto.randomUUID()), []);
});
