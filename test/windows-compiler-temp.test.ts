import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runManagedProcess } from '../src/utils/managed-process.js';

test('Windows Job launcher compiles with Unicode temporary paths and preserves the CLI environment', {
  skip: process.platform !== 'win32' ? '需要 Windows PowerShell 5.1 编译器和 Job Object' : false,
  timeout: 30000
}, async t => {
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'agy 编译 🙂-'));
  const keys = ['TEMP', 'TMP', 'ANTIGRAVITY_MCP_STATE_HOME'] as const;
  const previous = keys.map(key => process.env[key]);
  t.after(() => {
    const resolved = fs.realpathSync.native(directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert(path.basename(resolved).startsWith('agy 编译 🙂-'));
    assert(!fs.lstatSync(directory).isSymbolicLink());
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  try {
    for (const key of keys) process.env[key] = directory;
    const command = "console.log(JSON.stringify({temp:process.env.TEMP,tmp:process.env.TMP,cwd:process.cwd()}))";
    const result = await runManagedProcess(process.execPath, ['-e', command], { cwd: directory, timeoutMs: 15000 });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.error, undefined);
    assert.deepEqual(JSON.parse(result.stdout), { temp: directory, tmp: directory, cwd: directory });
    for (const key of keys) assert.equal(process.env[key], directory);
  } finally {
    for (let index = 0; index < keys.length; index++) {
      if (previous[index] === undefined) delete process.env[keys[index]];
      else process.env[keys[index]] = previous[index];
    }
  }
});
