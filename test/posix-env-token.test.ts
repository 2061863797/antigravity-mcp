import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findPidsByEnvToken } from '../src/utils/process-killer.js';

// 只模拟 /proc 字节，不读取真实进程，也不发送信号；Windows 同样执行这些回归。
test('environment token scanning matches complete entries, not another variable name or value', async t => {
  const token = '12345678-1234-4234-8234-123456789abc';
  const environment = new Map([
    [10101, `AGY_MCP_JOB_TOKEN=${token}\0PATH=/bin\0`],
    [10102, `PATH=/bin\0AGY_MCP_JOB_TOKEN=${token}\0`],
    [10103, `OTHER_AGY_MCP_JOB_TOKEN=${token}\0`],
    [10104, `TRACE=AGY_MCP_JOB_TOKEN=${token}\0`],
    [10105, `AGY_MCP_JOB_TOKEN=${token}-other\0`],
    [10106, `AGY_MCP_JOB_TOKEN=${token.slice(0, -1)}\0`],
    [10107, `AGY_MCP_JOB_TOKEN=${token}`],
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
  assert.deepEqual(await findPidsByEnvToken(token), [10101, 10102]);
  assert.deepEqual(await findPidsByEnvToken('not-present'), []);
});
