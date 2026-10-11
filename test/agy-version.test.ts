import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { ensureAgyVersion, parseAgyVersion, MIN_AGY_VERSION } from '../src/utils/agy-version.js';
import { executeAgy } from '../src/agy-executor.js';
import { queryNativeQuota } from '../src/utils/native-quota.js';
import { acquireWorkspaceLease, releaseWorkspaceLease } from '../src/utils/workspace-lease.js';

async function fixture(action: (directory: string, cli: string, calls: () => number) => Promise<void>) {
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'agy-version-'));
  const cli = path.join(directory, 'fake-agy.mjs'), counter = path.join(directory, 'versions');
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url)), cli);
  const keys = ['TEST_AGY_VERSION', 'TEST_VERSION_STARTS', 'TEST_MODEL_STARTS', 'ANTIGRAVITY_SKIP_VERSION_CHECK', 'ANTIGRAVITY_MCP_STATE_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.TEST_AGY_VERSION = 'agy 1.3.0'; process.env.TEST_VERSION_STARTS = counter;
  process.env.TEST_MODEL_STARTS = path.join(directory, 'models'); process.env.ANTIGRAVITY_MCP_STATE_HOME = directory;
  delete process.env.ANTIGRAVITY_SKIP_VERSION_CHECK;
  try { await action(directory, cli, () => fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').length : 0); }
  finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    const resolved = fs.realpathSync.native(directory); assert.equal(path.dirname(resolved), temporaryRoot);
    assert(path.basename(resolved).startsWith('agy-version-')); assert(!fs.lstatSync(directory).isSymbolicLink());
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

test('version parsing accepts semantic versions and rejects malformed or ambiguous output', () => {
  assert.equal(MIN_AGY_VERSION, '1.1.15');
  for (const version of ['1.1.15', '1.3.0', '2.0.0-rc.1', '1.1.15+build.01']) assert.equal(parseAgyVersion('agy v' + version), version);
  assert.equal(parseAgyVersion('\x1b[32magy 1.3.0\x1b[0m\n1.3.0'), '1.3.0');
  for (const text of ['unreadable', '1.02.3', '01.2.3', '1.2.3.4', '1.2.3-01', '1.2.3 and 2.0.0']) assert.equal(parseAgyVersion(text), undefined);
});

test('successful checks are cached by executable and wrapper modification times', async t => {
  await fixture(async (directory, cli, calls) => {
    const stat = fs.statSync; let offset = 0;
    t.mock.method(fs, 'statSync', ((...args: Parameters<typeof stat>) => {
      const result = stat(...args);
      if (result && path.resolve(String(args[0])) === fs.realpathSync.native(process.execPath)) Object.defineProperty(result, 'mtimeMs', { value: Number(result.mtimeMs) + offset });
      return result;
    }) as typeof stat);
    try {
      const check = () => ensureAgyVersion(process.execPath, [cli], { cwd: directory });
      assert.equal(await check(), '1.3.0'); assert.equal(calls(), 1);
      process.env.TEST_AGY_VERSION = 'agy 1.4.0'; assert.equal(await check(), '1.3.0'); assert.equal(calls(), 1);
      offset = 2000; assert.equal(await check(), '1.4.0'); assert.equal(calls(), 2);
      process.env.TEST_AGY_VERSION = 'agy 1.5.0';
      fs.utimesSync(cli, new Date(), new Date(Date.now() + 2000));
      assert.equal(await check(), '1.5.0'); assert.equal(calls(), 3);
      assert(!fs.existsSync(path.join(directory, 'models')));
    } finally { t.mock.restoreAll(); }
  });
});

for (const [version, code] of [['agy 1.1.14', 'AGY_VERSION_UNSUPPORTED'], ['unreadable', 'AGY_VERSION_UNREADABLE'], ['agy 1.1.15-rc.1', 'AGY_VERSION_UNSUPPORTED']]) {
  test(`version failure ${version} is explicit and is never cached`, async () => {
    await fixture(async (directory, cli, calls) => {
      process.env.TEST_AGY_VERSION = version;
      await assert.rejects(ensureAgyVersion(process.execPath, [cli], { cwd: directory }), { code }); assert.equal(calls(), 1);
      process.env.TEST_AGY_VERSION = 'agy 1.1.15';
      assert.equal(await ensureAgyVersion(process.execPath, [cli], { cwd: directory }), '1.1.15'); assert.equal(calls(), 2);
    });
  });
}

test('only the explicit skip value bypasses version execution', async () => {
  await fixture(async (directory, cli, calls) => {
    process.env.TEST_AGY_VERSION = 'unreadable'; process.env.ANTIGRAVITY_SKIP_VERSION_CHECK = '1';
    assert.equal(await ensureAgyVersion(process.execPath, [cli], { cwd: directory }), undefined); assert.equal(calls(), 0);
    process.env.ANTIGRAVITY_SKIP_VERSION_CHECK = '0';
    await assert.rejects(ensureAgyVersion(process.execPath, [cli], { cwd: directory }), { code: 'AGY_VERSION_UNREADABLE' });
    assert.equal(calls(), 1);
  });
});

test('execution and quota reject unsupported versions before a lease, model or usage query', async () => {
  await fixture(async (directory, cli, calls) => {
    process.env.TEST_AGY_VERSION = 'agy 1.0.0';
    const result = await executeAgy({ prompt: 'FIXTURE:{}', workspaceDir: directory, cliPath: process.execPath, cliArgsPrefix: [cli] });
    assert.equal(result.errorCode, 'AGY_VERSION_UNSUPPORTED'); assert.equal(result.executionStarted, false);
    assert.equal(result.failureStage, 'PREPARING'); assert.match(result.errorMessage!, /1\.0\.0.*1\.1\.15/);
    assert.match(result.nextAction!, /升级/); assert.equal(result.taskId, null);
    assert.equal(acquireWorkspaceLease('version-successor', directory), true); releaseWorkspaceLease('version-successor');
    const capture = path.join(directory, 'usage'); fs.writeFileSync(path.join(directory, '.quota-fixture.json'), JSON.stringify({ capture }));
    const quota = await queryNativeQuota(process.execPath, [cli], { cwd: directory });
    assert.equal(quota.errorCode, 'AGY_VERSION_UNSUPPORTED'); assert.equal(quota.status, 'ERROR'); assert.equal(calls(), 2);
    assert(!fs.existsSync(path.join(directory, 'models'))); assert(!fs.existsSync(capture));
    process.env.TEST_AGY_VERSION = 'unreadable';
    const unreadable = await executeAgy({ prompt: 'FIXTURE:{}', workspaceDir: directory, cliPath: process.execPath, cliArgsPrefix: [cli] });
    assert.equal(unreadable.errorCode, 'AGY_VERSION_UNREADABLE'); assert.match(unreadable.nextAction!, /ANTIGRAVITY_SKIP_VERSION_CHECK=1/);
  });
});

test('version timeout is bounded, hidden and not retried; aborted preflight starts nothing', async t => {
  await fixture(async (directory, cli, calls) => {
    let attempts = 0;
    const original = childProcess.execFile;
    const mock = () => { throw new Error('Expected the promisified version probe'); };
    Object.defineProperty(mock, promisify.custom, { value: async (_file: string, args: string[], options: childProcess.ExecFileOptions) => {
      attempts++; assert.deepEqual(args, [cli, '--version']); assert.equal(options.timeout, 10000); assert.equal(options.windowsHide, true);
      throw new Error('injected version timeout');
    } });
    childProcess.execFile = mock as unknown as typeof original; syncBuiltinESMExports();
    try {
      await assert.rejects(ensureAgyVersion(process.execPath, [cli], { cwd: directory }), { code: 'AGY_VERSION_UNREADABLE' });
      assert.equal(attempts, 1);
      const controller = new AbortController(); controller.abort();
      await assert.rejects(ensureAgyVersion(process.execPath, [cli], { cwd: directory, signal: controller.signal }), /CANCELLED/);
      assert.equal(attempts, 1); assert.equal(calls(), 0);
    } finally { childProcess.execFile = original; syncBuiltinESMExports(); }
  });
});
