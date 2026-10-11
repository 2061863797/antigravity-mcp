import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findPidsByEnvToken, findPidsByEnvTokenSync } from '../src/utils/process-killer.js';

// 只模拟 /proc 字节，不读取真实进程，也不发送信号；Windows 同样执行这些回归。
test('environment token scanning matches complete entries, not another variable name or value', async t => {
  const token = '12345678-1234-4234-8234-123456789abc';
  const pids = Array.from({ length: 7 }, (_, index) => process.pid + 100 + index);
  const environment = new Map([
    [pids[0], `AGY_MCP_JOB_TOKEN=${token}\0PATH=/bin\0`],
    [pids[1], `PATH=/bin\0AGY_MCP_JOB_TOKEN=${token}\0`],
    [pids[2], `OTHER_AGY_MCP_JOB_TOKEN=${token}\0`],
    [pids[3], `TRACE=AGY_MCP_JOB_TOKEN=${token}\0`],
    [pids[4], `AGY_MCP_JOB_TOKEN=${token}-other\0`],
    [pids[5], `AGY_MCP_JOB_TOKEN=${token.slice(0, -1)}\0`],
    [pids[6], `AGY_MCP_JOB_TOKEN=${token}`],
    [process.pid, `AGY_MCP_JOB_TOKEN=${token}\0`]
  ]);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  t.mock.method(fs.promises, 'readdir', async (directory: string) => {
    assert.equal(directory, '/proc');
    return [...environment.keys()].map(String).concat(['self', 'net', '0']);
  });
  t.mock.method(fs.promises, 'readFile', async (file: string) => {
    assert.match(file, /^\/proc\/[1-9]\d*\/environ$/);
    return Buffer.from(environment.get(Number(file.split('/')[2]))!);
  });
  t.mock.method(fs, 'readdirSync', (directory: string) => {
    assert.equal(directory, '/proc'); return [...environment.keys()].map(String);
  });
  t.mock.method(fs, 'readFileSync', (file: string) => Buffer.from(environment.get(Number(file.split('/')[2]))!));
  assert.deepEqual(await findPidsByEnvToken(token), pids.slice(0, 2));
  assert.deepEqual(findPidsByEnvTokenSync(token), pids.slice(0, 2));
  assert.deepEqual(await findPidsByEnvToken('not-present'), []);
  assert.deepEqual(findPidsByEnvTokenSync('not-present'), []);
});

test('an unreadable procfs is an explicit scan failure, not an empty process set', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const failure = Object.assign(new Error('procfs unreadable'), { code: 'EACCES' });
  t.mock.method(fs.promises, 'readdir', async () => { throw failure; });
  t.mock.method(fs, 'readdirSync', () => { throw failure; });
  await assert.rejects(findPidsByEnvToken('test-token'), { code: 'EACCES' });
  assert.throws(() => findPidsByEnvTokenSync('test-token'), { code: 'EACCES' });
});
