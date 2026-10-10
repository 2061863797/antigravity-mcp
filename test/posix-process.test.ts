import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { findPidsByEnvToken } from '../src/utils/process-killer.js';

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

test('environment token lookup returns empty on platforms without Linux procfs', {
  skip: process.platform === 'linux' ? 'Linux 使用上面的真实 /proc 扫描测试' : false
}, async () => {
  assert.deepEqual(await findPidsByEnvToken(crypto.randomUUID()), []);
});
