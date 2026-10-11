import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryNativeQuota } from '../src/utils/native-quota.js';
import { QuotaResultSchema } from '../src/utils/register-tool.js';

test('native quota retains stop diagnostics in its existing error message without retry', async t => {
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'agy-quota-diagnostic-'));
  const previousHome = process.env.ANTIGRAVITY_MCP_STATE_HOME;
  process.env.ANTIGRAVITY_MCP_STATE_HOME = directory;
  let calls = 0;
  const diagnostic = 'AGY_MCP_STOP_DIAGNOSTIC: AGY_MCP_STOP_STAGE=CIM_ENUMERATION';
  const command = { name: 'usage', data: { groups: [] } };
  const version = () => { throw new Error('Expected the promisified version check'); };
  const originalExec = childProcess.execFile;
  Object.defineProperty(version, promisify.custom, { value: async () => ({ stdout: 'agy 1.3.0', stderr: '' }) });
  childProcess.execFile = version as unknown as typeof originalExec;
  t.mock.method(childProcess, 'execFileSync', () => '134000000000000000');
  t.mock.method(childProcess, 'spawn', (_file: string, _args: string[], options: childProcess.SpawnOptions) => {
    calls++;
    assert.equal(options.windowsHide, true);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'result', result: {
        status: 'SUCCESS', response: 'fixture quota', conversation_id: '', command
      } }) + '\n'));
      child.stderr.emit('data', Buffer.from('AGY_MCP_JOB_FAILURE: fixture stop unconfirmed\n' + diagnostic));
      child.emit('close', 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    const result = await queryNativeQuota(process.execPath, [], { cwd: directory });
    assert.equal(result.status, 'ERROR');
    assert.equal(result.errorCode, 'PROCESS_TERMINATION_UNCONFIRMED');
    assert.match(result.errorMessage!, /^PROCESS_TERMINATION_UNCONFIRMED\n/);
    assert(result.errorMessage!.includes(diagnostic));
    assert.deepEqual(result.groups, []);
    assert.equal(calls, 1);
    assert.deepEqual(QuotaResultSchema.parse(result), result);
    assert(!('stderrTail' in result));
  } finally {
    childProcess.execFile = originalExec;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.ANTIGRAVITY_MCP_STATE_HOME;
    else process.env.ANTIGRAVITY_MCP_STATE_HOME = previousHome;
    const resolved = fs.realpathSync.native(directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert(path.basename(resolved).startsWith('agy-quota-diagnostic-'));
    assert(!fs.lstatSync(directory).isSymbolicLink());
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
