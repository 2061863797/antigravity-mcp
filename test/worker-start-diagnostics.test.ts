import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWindowsWorker } from '../src/utils/managed-process.js';
import { killProcessTree } from '../src/utils/process-killer.js';

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

test('Windows worker startup works without module autoload and removes only its private environment variables', {
  skip: process.platform !== 'win32' ? '需要实际 Windows PowerShell/CIM 启动测试进程' : false,
  timeout: 30000
}, async t => {
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'agy-worker-env-'));
  const capture = path.join(directory, 'environment.json'), value = '中文🙂 & $ literal';
  t.after(() => {
    const resolved = fs.realpathSync.native(directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert(path.basename(resolved).startsWith('agy-worker-env-'));
    assert(!fs.lstatSync(directory).isSymbolicLink());
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const original = childProcess.execFile;
  const mock = () => { throw new Error('Expected the promisified startup call'); };
  Object.defineProperty(mock, promisify.custom, { value: async (file: string, args: string[], options: childProcess.ExecFileOptions) => {
    const command = args.at(-1)!;
    return promisify(original)(file, [...args.slice(0, -1), "$PSModuleAutoLoadingPreference = 'None'\n" + command], options);
  } });
  childProcess.execFile = mock as unknown as typeof original;
  syncBuiltinESMExports();
  let pid: number | undefined;
  try {
    const worker = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({command:process.env.AGY_MCP_WORKER_COMMAND,cwd:process.env.AGY_MCP_WORKER_CWD,probe:process.env.TEST_WORKER_ENV}));setTimeout(()=>{},15000)";
    pid = await startWindowsWorker(process.execPath, ['-e', worker, capture], directory, { ...getDefaultEnvironment(), TEST_WORKER_ENV: value });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(capture)) {
      assert(Date.now() < deadline, '测试 worker 未写出环境记录');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), { probe: value });
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
    if (pid) assert.equal((await killProcessTree(pid)).verifiedTerminated, true);
  }
});
