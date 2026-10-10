import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { startWindowsWorker } from '../src/utils/managed-process.js';

test('Windows worker startup failures retain process diagnostics without retry or timeout changes', async () => {
  const original = childProcess.execFile;
  for (const details of [
    { code: null, signal: 'SIGTERM', killed: true, stderr: 'AGY_MCP_WORKER_STAGE=CIM_CREATE' },
    { code: 1, signal: null, killed: false, stderr: 'AGY_MCP_WORKER_STAGE=CIM_RETURN=9\nWORKER_START_FAILED: Windows process creation returned 9' }
  ]) {
    const failure = Object.assign(new Error('injected Windows startup failure'), details);
    let calls = 0;
    const mock = () => { throw new Error('Expected the promisified startup call'); };
    Object.defineProperty(mock, promisify.custom, { value: async (_file: string, _args: string[], options: { timeout: number; windowsHide: boolean }) => {
      calls++;
      assert.equal(options.timeout, 10000);
      assert.equal(options.windowsHide, true);
      throw failure;
    } });
    childProcess.execFile = mock as unknown as typeof original;
    syncBuiltinESMExports();
    try {
      await assert.rejects(startWindowsWorker('unused-worker.exe', [], process.cwd(), {}), error => {
        assert(error instanceof Error);
        assert.equal(error.cause, failure);
        assert(error.message.startsWith('WORKER_START_FAILED:'));
        const diagnostic = /Windows startup diagnostic: (\{[^\n]+\})/.exec(error.message);
        assert(diagnostic);
        assert.deepEqual(JSON.parse(diagnostic[1]), { code: details.code, signal: details.signal, killed: details.killed });
        assert(error.message.includes(details.stderr));
        return true;
      });
      assert.equal(calls, 1);
    } finally {
      childProcess.execFile = original;
      syncBuiltinESMExports();
    }
  }
});
