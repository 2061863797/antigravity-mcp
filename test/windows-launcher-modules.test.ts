import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runManagedProcess } from '../src/utils/managed-process.js';

test('Windows Job launcher works without module autoload and clears only its private environment', {
  skip: process.platform !== 'win32' ? '需要 Windows PowerShell 与 Job Object 启动器' : false,
  timeout: 30000
}, async t => {
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'agy-launcher-modules-'));
  const previousHome = process.env.ANTIGRAVITY_MCP_STATE_HOME;
  process.env.ANTIGRAVITY_MCP_STATE_HOME = directory;
  const original = childProcess.spawn;
  const probe = '中文🙂 & $ literal';
  t.mock.method(childProcess, 'spawn', (file: string, args: string[], options: childProcess.SpawnOptions) => {
    const index = args.indexOf('-File'); assert(index >= 0);
    const script = "$PSModuleAutoLoadingPreference = 'None'\n& '" + args[index + 1].replaceAll("'", "''") + "'";
    return original(file, [...args.slice(0, index), '-Command', script], {
      ...options, env: { ...options.env, TEST_LAUNCHER_ENV: probe }
    });
  });
  syncBuiltinESMExports();
  try {
    const code = 'console.log(JSON.stringify({probe:process.env.TEST_LAUNCHER_ENV,command:process.env.AGY_MCP_COMMANDLINE,cwd:process.env.AGY_MCP_CWD,owner:process.env.AGY_MCP_OWNER_PID,createdAt:process.env.AGY_MCP_OWNER_CREATED_AT}))';
    const result = await runManagedProcess(process.execPath, ['-e', code], { cwd: directory, timeoutMs: 10000 });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.error, undefined);
    assert.equal(result.stopped, true);
    assert.deepEqual(JSON.parse(result.stdout), { probe });
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.ANTIGRAVITY_MCP_STATE_HOME;
    else process.env.ANTIGRAVITY_MCP_STATE_HOME = previousHome;
    const resolved = fs.realpathSync.native(directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert(path.basename(resolved).startsWith('agy-launcher-modules-'));
    assert(!fs.lstatSync(directory).isSymbolicLink());
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
