import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runDoctor, type DoctorReport } from '../src/utils/doctor.js';

const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'agy-doctor-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const source = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
// 每个用例复制独立的假 CLI，避免成功版本缓存影响其他用例。
const fakeCli = (name: string) => { const file = path.join(root, name + '.mjs'); fs.copyFileSync(source, file); return file; };
const check = (report: DoctorReport, name: string) => report.checks.find(item => item.name === name)!;
async function withEnv<T>(values: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await action(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('doctor passes every check without starting a model', async () => {
  const state = path.join(root, 'state-ok'), starts = path.join(root, 'models-ok');
  await withEnv({ ANTIGRAVITY_MCP_STATE_HOME: state, TEST_AGY_VERSION: 'agy 1.3.0', TEST_MODEL_STARTS: starts, ANTIGRAVITY_SKIP_VERSION_CHECK: undefined }, async () => {
    const report = await runDoctor({ cliPath: process.execPath, cliArgsPrefix: [fakeCli('ok')], platform: 'win32', languageMode: () => 'FullLanguage\r\n' });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(report.checks.map(item => item.name), ['agy', 'config', 'stateDir', 'powershell']);
    assert.equal(check(report, 'agy').detail.version, '1.3.0');
    assert.equal(typeof check(report, 'config').detail.defaultModel, 'string');
    assert.equal(typeof check(report, 'config').detail.defaultEffort, 'string');
    assert.equal(check(report, 'powershell').detail.languageMode, 'FullLanguage');
    assert.deepEqual(fs.readdirSync(path.join(state, '.gemini', 'antigravity-mcp-jobs-v1')), []);
    assert(!fs.existsSync(starts));
    const posix = await runDoctor({ cliPath: process.execPath, cliArgsPrefix: [fakeCli('ok-posix')], platform: 'linux', languageMode: () => assert.fail('not called') });
    assert.equal(posix.ok, true); assert.equal(check(posix, 'powershell').skipped, true);
  });
});

test('doctor reports unsupported agy, constrained PowerShell and unwritable state as failures', async () => {
  const blocker = path.join(root, 'state-file'); fs.writeFileSync(blocker, 'not a directory');
  await withEnv({ ANTIGRAVITY_MCP_STATE_HOME: blocker, TEST_AGY_VERSION: 'agy 1.0.0', ANTIGRAVITY_SKIP_VERSION_CHECK: undefined }, async () => {
    const report = await runDoctor({ cliPath: process.execPath, cliArgsPrefix: [fakeCli('old')], platform: 'win32', languageMode: () => 'ConstrainedLanguage' });
    assert.equal(report.ok, false);
    assert.equal(check(report, 'agy').ok, false); assert.equal(check(report, 'agy').detail.errorCode, 'AGY_VERSION_UNSUPPORTED');
    assert.equal(check(report, 'stateDir').ok, false);
    assert.equal(check(report, 'powershell').ok, false); assert.match(String(check(report, 'powershell').detail.hint), /ConstrainedLanguage/);
    assert.equal(check(report, 'config').ok, true);
    const unreadable = await runDoctor({ cliPath: process.execPath, cliArgsPrefix: [fakeCli('throws')], platform: 'win32', languageMode: () => { throw new Error('blocked'); } });
    assert.equal(check(unreadable, 'powershell').ok, false); assert.match(String(check(unreadable, 'powershell').detail.error), /blocked/);
  });
});

test('doctor reports a missing agy path', async () => {
  await withEnv({ AGY_PATH: path.join(root, 'missing-agy.exe'), ANTIGRAVITY_MCP_STATE_HOME: path.join(root, 'state-missing') }, async () => {
    const report = await runDoctor({ platform: 'linux' });
    assert.equal(report.ok, false); assert.equal(check(report, 'agy').detail.errorCode, 'AGY_NOT_FOUND');
  });
});

test('--doctor prints JSON, exits non-zero for invalid config and registers no MCP tools', async () => {
  const config = path.join(root, 'invalid-config.json'); fs.writeFileSync(config, '{"defaultModel":"Bad Model"}');
  const env = { ...process.env, ANTIGRAVITY_CONFIG_PATH: config, ANTIGRAVITY_MCP_STATE_HOME: path.join(root, 'state-cli'), AGY_PATH: path.join(root, 'missing-agy.exe') };
  const failure = await promisify(execFile)(process.execPath, [path.resolve('dist/index.js'), '--doctor'], { env, windowsHide: true, timeout: 30000 })
    .then(() => assert.fail('doctor must exit non-zero'), (error: { code: number; stdout: string }) => error);
  assert.equal(failure.code, 1);
  const report = JSON.parse(failure.stdout) as DoctorReport;
  assert.equal(report.ok, false); assert.equal(check(report, 'config').ok, false);
  assert.match(String(check(report, 'config').detail.error), /INVALID_CONFIG/); assert.equal(check(report, 'config').detail.path, config);
  assert.equal(check(report, 'stateDir').ok, true);
  assert(!/"jsonrpc"/.test(failure.stdout));
});
