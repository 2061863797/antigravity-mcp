import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Windows CI 的 TEMP 可能是 8.3 短路径；预期值使用与执行器一致的实际路径。
const temporaryRoot = fs.realpathSync.native(os.tmpdir()), suite = fs.mkdtempSync(path.join(temporaryRoot, 'antigravity-channel-'));
const home = path.join(suite, 'home'); fs.mkdirSync(home);
(os as unknown as { homedir: () => string }).homedir = () => home;
const starts = path.join(suite, 'starts'); process.env.TEST_MODEL_STARTS = starts;
const { executeAgy, validateCommandLine } = await import('../src/agy-executor.js');
const { taskTracker, TaskTracker } = await import('../src/utils/task-tracker.js');
const { acquireWorkspaceLease, releaseWorkspaceLease } = await import('../src/utils/workspace-lease.js');
const { runManagedProcess, startWindowsWorker } = await import('../src/utils/managed-process.js');
const { isProcessAlive, killProcessTree } = await import('../src/utils/process-killer.js');
const { captureCreatedAt, identityState } = await import('../src/utils/process-identity.js');
const { ConfigManager } = await import('../src/utils/config-manager.js');
const { sessionManager } = await import('../src/utils/session-manager.js');
const { queryNativeQuota } = await import('../src/utils/native-quota.js');
const { readTask, saveTask, taskFile } = await import('../src/utils/task-store.js');
const { createAntigravityServer } = await import('../src/server.js');
const { normalizeResult, summarizeTask, TaskSummarySchema } = await import('../src/utils/register-tool.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
type Options = import('../src/agy-executor.js').AgyExecuteOptions;
const cli = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
const fixture = (name: string) => { const directory = path.join(suite, name); fs.mkdirSync(directory, { recursive: true }); return directory; };
const write = (directory: string, name: string, content: string) => { const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
const run = (workspaceDir: string, input: Record<string, unknown> = {}, options: Partial<Options> = {}) =>
  executeAgy({ prompt: 'FIXTURE:' + JSON.stringify(input), workspaceDir, cliPath: process.execPath, cliArgsPrefix: [cli], requestWaitTimeoutMs: 20000, ...options });
const startCount = () => fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').split('\n').filter(Boolean).length : 0;
const nativeQuota = (remaining = 0.9) => ({ groups: [{ name: 'Gemini Models', buckets: [
  { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: remaining, reset_time: '2050-10-13T14:27:34Z' },
  { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.8, reset_time: '2050-10-08T14:09:09Z' }
] }] });
const workerFault = async <T>(operation: 'renameSync' | 'unlinkSync', needle: string, action: () => Promise<T>): Promise<T> => {
  const marker = write(suite, crypto.randomUUID() + '.fault', 'enabled');
  const preload = write(suite, crypto.randomUUID() + '.mjs', "import fs from 'node:fs';if(process.argv.some(value=>/task-worker\\.(ts|js)$/.test(value))){const original=fs." + operation +
    ";fs." + operation + "=(...args)=>{if(fs.existsSync(" + JSON.stringify(marker) + ")&&String(args[" + (operation === 'renameSync' ? 1 : 0) + "]).includes(" + JSON.stringify(needle) +
    "))throw Object.assign(new Error(" + JSON.stringify(operation === 'unlinkSync' ? 'LEASE_RELEASE_FAILED: injected worker refusal' : 'EACCES: injected worker refusal') + "),{code:'EACCES'});return original(...args)};}");
  const previous = process.env.NODE_OPTIONS; process.env.NODE_OPTIONS = (previous ?? '') + ' --import ' + pathToFileURL(preload).href;
  try { return await action(); }
  finally { fs.unlinkSync(marker); if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
};
const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (!await condition()) { if (Date.now() >= end) throw new Error('Timed out waiting for state'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const final = async (id: string, timeout = 15000) => { await waitFor(() => taskTracker.get(id)?.result.status !== 'RUNNING', timeout); return taskTracker.report(taskTracker.get(id)!); };
after(async () => {
  await taskTracker.shutdownAll();
  const previous = process.env.ANTIGRAVITY_MCP_STATE_HOME;
  try {
    for (const directory of [home, path.join(suite, 'client-home')]) {
      process.env.ANTIGRAVITY_MCP_STATE_HOME = directory;
      const records = path.join(directory, '.gemini', 'antigravity-mcp-jobs-v1');
      if (!fs.existsSync(records)) continue;
      const tracker = new TaskTracker();
      for (const file of fs.readdirSync(records).filter(file => file.endsWith('.task.json'))) {
        const id = file.slice(0, -10), record = readTask(id); if (!record) continue;
        if (record.result.status === 'RUNNING') await tracker.cancel(id);
        if (record.workerPid) {
          try { await waitFor(() => identityState(record.workerPid!, record.workerCreatedAt, undefined, true) === 'EXITED'); }
          catch (error) { throw new Error(`${String(error)}; worker cleanup diagnostic: ${JSON.stringify({ taskId: id,
            status: record.result.status, workerPid: record.workerPid, expectedCreatedAt: record.workerCreatedAt,
            observedCreatedAt: captureCreatedAt(record.workerPid) })}`, { cause: error }); }
        }
      }
    }
  } finally { if (previous === undefined) delete process.env.ANTIGRAVITY_MCP_STATE_HOME; else process.env.ANTIGRAVITY_MCP_STATE_HOME = previous; }
  assert.equal(path.dirname(path.resolve(suite)), path.resolve(temporaryRoot)); assert(path.basename(suite).startsWith('antigravity-channel-'));
  fs.rmSync(suite, { recursive: true, force: true });
});

test('coding without changes succeeds; model prose is not machine verification', async () => {
  const workspace = fixture('no-changes'), result = await run(workspace, { response: 'No files were modified. All tests passed.' });
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result)); assert.equal(result.schemaVersion, 3); assert(!('verification' in result));
  assert.equal(result.model, 'gemini-3.8-flash-high'); assert.equal(result.effort, 'high');
  assert.equal(result.upstreamDurationSeconds, 123); assert(result.elapsedSeconds !== null && result.elapsedSeconds < 30);
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 4 }); assert(!('audit' in result)); assert(!('rollback' in result)); assert(!('tokens' in result));
  assert.equal(result.cliMode, 'accept-edits'); assert.equal(result.autoApprove, true); assert.equal(result.cliPermissionMode, 'always-proceed');
  assert.equal(result.cliStatus, 'SUCCESS'); assert.equal(result.usageScope, 'session');
  assert(!('rewind' in result)); assert.equal(result.rawLog, null); assert(!fs.existsSync(path.join(home, '.gemini', 'antigravity-mcp-logs')));
  assert(!fs.existsSync(path.join(home, '.gemini', 'antigravity-mcp-tasks-v3')));
  assert.equal(acquireWorkspaceLease('successor', workspace), true); releaseWorkspaceLease('successor');
});

test('tasks never query quota and old quota records are read without migration or extra output fields', async () => {
  const workspace = fixture('quota-roundtrip'), capture = path.join(workspace, 'quota-capture.jsonl');
  write(workspace, '.quota-fixture.json', JSON.stringify({ data: nativeQuota(), capture }));
  const count = startCount(), result = await run(workspace);
  assert.equal(result.status, 'SUCCESS'); assert.equal(startCount(), count + 1); assert(!('quota' in result)); assert(!fs.existsSync(capture));
  const tracker = new TaskTracker(); assert(!('quota' in tracker.report(tracker.get(result.taskId!)!)));
  const file = taskFile(result.taskId!), old = JSON.parse(fs.readFileSync(file, 'utf8')); old.result.quota = { oldSnapshot: true };
  const bytes = JSON.stringify(old); fs.writeFileSync(file, bytes);
  assert(!('quota' in new TaskTracker().get(result.taskId!)!.result)); assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  old.result.unexpected = true; fs.writeFileSync(file, JSON.stringify(old));
  assert.throws(() => new TaskTracker().get(result.taskId!), /TASK_RECORD_INVALID/); fs.writeFileSync(file, bytes);
});
test('native quota is a standalone read with native arguments, limits and no model, session or task creation', async () => {
  const workspace = fixture('quota-warning'), capture = path.join(workspace, 'quota-capture.jsonl');
  write(workspace, '.quota-fixture.json', JSON.stringify({ data: nativeQuota(0.08), capture }));
  const records = path.join(home, '.gemini', 'antigravity-mcp-jobs-v1'), sessions = path.join(home, '.gemini', 'antigravity-mcp-conversations-v3');
  const before = [fs.readdirSync(records), fs.readdirSync(sessions)], count = startCount();
  const result = await queryNativeQuota(process.execPath, [cli], { cwd: workspace });
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.groups[0].buckets[0].remaining_fraction, 0.08);
  assert(result.warnings.some(message => message.includes('8%'))); assert.equal(startCount(), count);
  assert.deepEqual([fs.readdirSync(records), fs.readdirSync(sessions)], before);
  const invocations = fs.readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(invocations.length, 1); const args = invocations[0].args;
  assert.equal(args[args.indexOf('-p') + 1], '/usage'); assert.equal(args[args.indexOf('--print-timeout') + 1], '10s');
  assert(!args.includes('--disable-slash-commands') && !args.includes('--conversation') && !args.includes('--model'));
});
test('quota failure retains partial edits, asks the user, and only an explicit continuation starts another model', async () => {
  const workspace = fixture('quota-exhausted'); write(workspace, '.quota-fixture.json', JSON.stringify({ data: nativeQuota(0) }));
  const count = startCount(), failed = await run(workspace, { error: 'Quota exhausted for Gemini Models', writes: { 'a.txt': 'partial' } });
  assert.equal(failed.status, 'ERROR'); assert.equal(failed.errorCode, 'CLI_QUOTA_EXHAUSTED'); assert(!('quota' in failed));
  assert.match(failed.nextAction!, /请用户选择/); assert(failed.conversationId); assert.equal(startCount(), count + 1);
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'partial');
  write(workspace, '.quota-fixture.json', JSON.stringify({ data: nativeQuota() }));
  const resumed = await run(workspace, { writes: { 'a.txt': 'finished' } }, { conversationId: failed.conversationId! });
  assert.equal(resumed.status, 'SUCCESS'); assert.equal(resumed.conversationId, failed.conversationId); assert.notEqual(resumed.taskId, failed.taskId);
  assert.equal(startCount(), count + 2); assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'finished');
  assert.equal(taskTracker.get(failed.taskId!)!.result.errorCode, 'CLI_QUOTA_EXHAUSTED');
});
test('quota query errors stay separate while transient 429 and model prose do not create exhaustion', async () => {
  const workspace = fixture('quota-unavailable'); write(workspace, '.quota-fixture.json', JSON.stringify({ malformed: true }));
  const result = await run(workspace, { response: 'Quota exhausted is discussed in the documentation.' });
  assert.equal(result.status, 'SUCCESS'); assert(!('quota' in result));
  const malformed = await queryNativeQuota(process.execPath, [cli], { cwd: workspace });
  assert.equal(malformed.status, 'ERROR'); assert.equal(malformed.errorCode, 'CLI_OUTPUT_INVALID'); assert.deepEqual(malformed.groups, []);
  write(workspace, '.quota-fixture.json', JSON.stringify({ successError: 'explicit quota query failure' }));
  const explicit = await run(workspace);
  assert.equal(explicit.status, 'SUCCESS');
  const query = await queryNativeQuota(process.execPath, [cli], { cwd: workspace });
  assert.equal(query.status, 'ERROR'); assert.equal(query.errorMessage, 'explicit quota query failure');
  const transient = await run(fixture('quota-transient'), { error: 'HTTP 429: Too many requests' });
  assert.equal(transient.errorCode, 'CLI_ERROR');
});
test('an exhausted baseline is a warning and does not override a successful native call using its own credits policy', async () => {
  const workspace = fixture('quota-credits-policy'); write(workspace, '.quota-fixture.json', JSON.stringify({ data: nativeQuota(0) }));
  const result = await run(workspace); assert.equal(result.status, 'SUCCESS'); assert(!('quota' in result));
  const query = await queryNativeQuota(process.execPath, [cli], { cwd: workspace });
  assert.equal(query.status, 'SUCCESS'); assert(query.warnings.every(message => message.includes('credits')));
});
test('cancelling standalone quota stops its process without creating a task or changing source files', async () => {
  const workspace = fixture('quota-cancel'), capture = path.join(workspace, 'query.jsonl'); write(workspace, 'protected.txt', 'source');
  write(workspace, '.quota-fixture.json', JSON.stringify({ delay: 5000, capture }));
  const count = startCount(), controller = new AbortController();
  const pending = queryNativeQuota(process.execPath, [cli], { cwd: workspace, signal: controller.signal });
  await waitFor(() => fs.existsSync(capture));
  const pid = JSON.parse(fs.readFileSync(capture, 'utf8').trim()).pid;
  controller.abort(); const cancelled = await pending; assert.equal(cancelled.errorCode, 'CANCELLED'); assert.equal(cancelled.status, 'ERROR');
  assert.equal(await isProcessAlive(pid), false); assert.equal(startCount(), count);
  assert.equal(fs.readFileSync(path.join(workspace, 'protected.txt'), 'utf8'), 'source');
  assert.equal(acquireWorkspaceLease('after-quota-cancel', workspace), true); releaseWorkspaceLease('after-quota-cancel');
});
test('successful coding retains edits for independent inspection and runs no verification commands', async () => {
  const workspace = fixture('coding-edits');
  write(workspace, 'verify.cjs', "require('fs').writeFileSync('unexpected.txt','ran');");
  const result = await run(workspace, { writes: { 'a.txt': 'new' } });
  assert.equal(result.status, 'SUCCESS'); assert(!('verification' in result));
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'new'); assert(!fs.existsSync(path.join(workspace, 'unexpected.txt')));
});

test('delayed quota cannot replace a completed success or an explicit quota failure with a task timeout', async () => {
  for (const error of [undefined, 'Quota exhausted']) {
    const workspace = fixture(error ? 'quota-deadline-error' : 'quota-deadline-success'), capture = path.join(workspace, 'quota-capture.jsonl');
    write(workspace, '.quota-fixture.json', JSON.stringify({ delay: 20000, capture }));
    const count = startCount(), result = await run(workspace, { error, response: 'model finished', writes: { 'a.txt': 'kept' } }, { executionTimeoutMs: 8000 });
    assert.equal(result.status, error ? 'ERROR' : 'SUCCESS'); assert.equal(result.errorCode, error ? 'CLI_QUOTA_EXHAUSTED' : null);
    assert.equal(result.response, 'model finished'); assert.equal(startCount(), count + 1); assert(!fs.existsSync(capture));
    assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'kept'); assert(!('quota' in result));
    if (error) assert.match(result.nextAction!, /请用户选择/);
  }
});
test('a native quota timeout stops only the query and leaves an unrelated active task running', async () => {
  const workspace = fixture('quota-timeout-active'), quotaWorkspace = fixture('quota-timeout-query');
  write(quotaWorkspace, '.quota-fixture.json', JSON.stringify({ delay: 20000 }));
  const active = await run(workspace, { hang: true, writes: { 'a.txt': 'kept' } }, { asyncMode: true });
  let pid = 0;
  try {
    const quota = await queryNativeQuota(process.execPath, [cli], { cwd: quotaWorkspace, onSpawn: value => { pid = value; } });
    assert.equal(quota.status, 'ERROR'); assert.equal(quota.errorCode, 'TIMEOUT'); assert.equal(await isProcessAlive(pid), false);
    assert.equal(taskTracker.get(active.taskId!)!.result.status, 'RUNNING'); assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'kept');
  } finally { await taskTracker.cancel(active.taskId!); }
});
test('stderr retains the real tail beyond five MiB and classifies its final quota error', async () => {
  const chinese = Buffer.from('额度已耗尽：最终诊断'), parts = [chinese.subarray(0, 2), chinese.subarray(2, 5), chinese.subarray(5)];
  const result = await run(fixture('stderr-final-quota'), { silent: true, omitResult: true, exitCode: 1,
    stderrBytes: 6 * 1024 * 1024, stderrChunks: parts.map(part => [...part]) });
  assert.equal(result.status, 'ERROR'); assert.equal(result.errorCode, 'CLI_QUOTA_EXHAUSTED'); assert(result.stderrTail.length <= 8192);
  assert.match(result.stderrTail, /额度已耗尽：最终诊断/); assert.match(result.cliError!, /额度已耗尽：最终诊断/);
  assert(!result.stderrTail.includes('�')); assert.match(result.nextAction!, /请用户选择/);
  for (const [name, stderr, expected] of [
    ['quota-generic-final', '额度已耗尽：原生 stderr 诊断', 'CLI_QUOTA_EXHAUSTED'],
    ['rate-generic-final', 'HTTP 429: too many requests', 'CLI_ERROR']
  ] as const) {
    const workspace = fixture(name), response = '已完成的结果片段';
    const result = await run(workspace, { error: 'Service request failed', stderr, response, writes: { 'partial.txt': response } });
    assert.equal(result.status, 'ERROR'); assert.equal(result.errorCode, expected); assert.equal(result.cliError, 'Service request failed');
    assert.match(result.stderrTail, new RegExp(stderr)); assert.equal(result.response, response); assert(result.conversationId);
    assert.equal(fs.readFileSync(path.join(workspace, 'partial.txt'), 'utf8'), response);
  }
});
test('a launcher failure marker split across stderr chunks cannot produce a successful task', async () => {
  const result = await run(fixture('stderr-split-marker'), { stderrChunks: ['AGY_MCP_JOB_', 'FAILURE: injected diagnostic'] });
  assert.equal(result.status, 'RUNNING'); assert.equal(result.errorCode, 'PROCESS_TERMINATION_UNCONFIRMED');
  assert.match(result.stderrTail, /AGY_MCP_JOB_FAILURE:/);
  const stopped = await taskTracker.cancel(result.taskId!); assert.equal(stopped!.result.status, 'CANCELLED');
});



test('API errors, invalid final output and nonzero exits fail without reverting edits', async () => {
  for (const [name, input, code] of [
    ['api', { error: 'API unavailable' }, 'CLI_ERROR'], ['invalid', { malformed: true }, 'CLI_OUTPUT_INVALID'],
    ['unknown', { unknown: true, omitResult: true }, 'CLI_OUTPUT_INVALID'], ['exit', { exitCode: 4 }, 'CLI_EXIT_FAILED'],
    ['success-error', { successError: 'explicit error' }, 'CLI_ERROR']
  ] as const) {
    const workspace = fixture(name), result = await run(workspace, { ...input, writes: { 'a.txt': name } });
    assert.equal(result.errorCode, code); assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), name);
    assert.equal(result.failureStage, code === 'CLI_OUTPUT_INVALID' ? 'RESULT' : 'CLI'); assert.equal(result.executionStarted, true); assert(result.nextAction);
  }
});
test('invalid or retired stdout fails even before an official success, without rerunning or reverting files', async () => {
  for (const [name, rawOutput] of [
    ['broken-json', '{broken}\n'], ['stdout-diagnostic', 'unexpected stdout text\n'],
    ['retired-type', '{"type":"result","status":"SUCCESS","response":"old"}\n'],
    ['retired-json', JSON.stringify({ status: 'SUCCESS', response: 'old' }, null, 2) + '\n']
  ]) {
    const workspace = fixture(name), before = startCount();
    const result = await run(workspace, { rawOutput, writes: { 'a.txt': name } });
    assert.equal(result.status, 'ERROR'); assert.equal(result.errorCode, 'CLI_OUTPUT_INVALID'); assert.equal(result.failureStage, 'RESULT');
    assert.equal(startCount(), before + 1); assert(result.conversationId);
    assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), name);
    assert.equal(acquireWorkspaceLease('after-' + name, workspace), true); releaseWorkspaceLease('after-' + name);
  }
});
test('analysis intent, explicit planning, approval and effort reach the CLI independently', async () => {
  for (const [name, options, effort, mode, approval] of [
    ['ask-normal', { analysis: true }, 'high', 'accept-edits', true],
    ['code-plan', { mode: 'plan' }, 'high', 'plan', true],
    ['explicit-max', { effort: 'max', autoApprove: true }, 'max', 'accept-edits', true],
    ['explicit-xhigh', { effort: 'xhigh' }, 'xhigh', 'accept-edits', true],
    ['ask-review', { analysis: true, autoApprove: false }, 'high', 'accept-edits', false],
    ['code-review', { autoApprove: false }, 'high', 'accept-edits', false],
    ['code-plan-review', { mode: 'plan', autoApprove: false }, 'high', 'plan', false]
  ] as const) {
    const workspace = fixture(name), capture = path.join(suite, name + '.args.json');
    const result = await run(workspace, { capture }, options); assert.equal(result.status, 'SUCCESS');
    const args: string[] = JSON.parse(fs.readFileSync(capture, 'utf8')).args;
    assert.equal(args[args.indexOf('--mode') + 1], mode); assert.equal(args[args.indexOf('--effort') + 1], effort);
    assert.equal(args.includes('--dangerously-skip-permissions'), approval); assert.equal(args[args.indexOf('--print-timeout') + 1], '0');
    assert.equal(args.includes('--disable-slash-commands'), mode !== 'plan');
    assert.equal(result.autoApprove, approval); assert.equal(result.cliPermissionMode, approval ? 'always-proceed' : 'request-review');
    assert.equal(result.executionWorkspaceDir, workspace);
    const prompt = args[args.indexOf('-p') + 1];
    if (name.startsWith('ask-')) assert.match(prompt, /Analyze only; do not modify files/);
    if (name.startsWith('code-plan')) assert.match(prompt, /Produce the requested plan/);
  }
});
test('official CLI end states preserve responses and file changes on incomplete runs', async () => {
  for (const [status, code, taskStatus] of [
    ['ERROR', 'CLI_ERROR', 'ERROR'], ['CANCELED', 'CANCELLED', 'CANCELLED'], ['INTERRUPTED', 'CLI_INTERRUPTED', 'ERROR'],
    ['INVALID', 'CLI_INVALID', 'ERROR'], ['WAITING', 'CLI_WAITING', 'ERROR'], ['RUNNING', 'CLI_INCOMPLETE', 'ERROR']
  ] as const) {
    const workspace = fixture('cli-state-' + status);
    const result = await run(workspace, { status, response: 'partial response', writes: { 'partial.txt': status } });
    assert.equal(result.cliStatus, status); assert.equal(result.errorCode, code); assert.equal(result.status, taskStatus); assert.equal(result.response, 'partial response');
    assert(!('verification' in result)); assert.equal(result.failureStage, 'CLI'); assert(result.nextAction);
    assert.equal(fs.readFileSync(path.join(workspace, 'partial.txt'), 'utf8'), status); assert(!fs.existsSync(path.join(workspace, 'verified.txt')));
    assert.equal(acquireWorkspaceLease('after-' + status, workspace), true); releaseWorkspaceLease('after-' + status);
  }
});
test('startup errors with no CLI session are upstream failures; successful permission notices remain visible', async () => {
  const failed = await run(fixture('pre-session-error'), { silent: true, error: 'invalid model selection', response: '', resultConversationId: '', exitCode: 1 });
  assert.equal(failed.errorCode, 'CLI_ERROR'); assert.equal(failed.cliStatus, 'ERROR'); assert.equal(failed.conversationId, null);
  assert.match(failed.cliError!, /invalid model selection/); assert.match(failed.errorMessage!, /invalid model selection/);
  const unauthenticated = await run(fixture('startup-stderr-only'), { silent: true, omitResult: true, exitCode: 1, stderr: 'authentication required' });
  assert.equal(unauthenticated.errorCode, 'CLI_EXIT_FAILED'); assert.equal(unauthenticated.failureStage, 'CLI');
  assert.match(unauthenticated.errorMessage!, /authentication required/); assert.match(unauthenticated.stderrTail, /authentication required/);
  const notice = 'permission denied: run_command requires a configured allow rule';
  const completed = await run(fixture('permission-notice'), { stderr: notice, response: 'only a partial investigation was possible' });
  assert.equal(completed.status, 'SUCCESS'); assert.equal(completed.cliError, null); assert.match(completed.stderrTail, /permission denied/);
  assert(!('verification' in completed));
});
test('analysis uses the original directory without copying; its no-write instruction is not enforcement', async () => {
  const workspace = fixture('direct-review'); write(workspace, 'a.txt', 'source'); write(workspace, 'node_modules/local.txt', 'dependency');
  const result = await run(workspace, { writes: { 'a.txt': 'changed' } }, { analysis: true });
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.executionWorkspaceDir, workspace);
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'changed');
  assert(!('workspaceMode' in result)); assert(!('isolation' in result));
  assert(!fs.existsSync(path.join(home, '.gemini', 'antigravity-mcp-workspaces-v3')));
});

test('simultaneous analysis tasks in the same directory conflict', async () => {
  const workspace = fixture('shared-analysis');
  const running = await run(workspace, { hang: true }, { analysis: true, asyncMode: true });
  try { assert.equal((await run(workspace, {}, { analysis: true })).errorCode, 'WORKSPACE_BUSY'); }
  finally { await taskTracker.cancel(running.taskId!); }
});

test('continuation reuses its directory without fingerprint or implicit continuation', async () => {
  const workspace = fixture('continue'); write(workspace, 'a.txt', 'initial'); const first = await run(workspace, {}, { analysis: true }); assert(first.conversationId);
  write(workspace, 'a.txt', 'changed source'); const resumed = await run(workspace, {}, { analysis: true, conversationId: first.conversationId });
  assert.equal(resumed.status, 'SUCCESS'); assert.equal(resumed.conversationId, first.conversationId); assert.equal(resumed.executionWorkspaceDir, first.executionWorkspaceDir);
  const count = startCount();
  assert.equal((await run(fixture('wrong-workspace'), {}, { conversationId: first.conversationId })).errorCode, 'CONVERSATION_WORKSPACE_MISMATCH');
  assert.equal((await run(workspace, {}, { conversationId: 'unknown' })).errorCode, 'CONVERSATION_UNKNOWN'); assert.equal(startCount(), count);
  assert.notEqual((await run(workspace)).conversationId, first.conversationId);
  fs.renameSync(first.executionWorkspaceDir!, first.executionWorkspaceDir! + '-moved');
  assert.equal((await run(workspace, {}, { conversationId: first.conversationId })).errorCode, 'CONVERSATION_WORKSPACE_MISSING');
});
test('continuation inherits saved model and effort, then persists explicit overrides independently', async () => {
  const workspace = fixture('saved-settings'), capture = path.join(workspace, 'args.json');
  const first = await run(workspace, {}, { model: 'saved-model', effort: 'xhigh' });
  const inherited = await run(workspace, { capture }, { conversationId: first.conversationId! });
  assert.equal(inherited.model, 'saved-model'); assert.equal(inherited.effort, 'xhigh');
  const args = JSON.parse(fs.readFileSync(capture, 'utf8')).args;
  assert.equal(args[args.indexOf('--model') + 1], 'saved-model'); assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
  const override = await run(workspace, {}, { conversationId: first.conversationId!, effort: 'max' });
  assert.equal(override.model, 'saved-model'); assert.equal(override.effort, 'max');
  const last = await run(workspace, {}, { conversationId: first.conversationId!, model: 'other-model' });
  assert.equal(last.model, 'other-model'); assert.equal(last.effort, 'max');
  const file = path.join(home, '.gemini', 'antigravity-mcp-conversations-v3', crypto.createHash('sha256').update(first.conversationId!).digest('hex') + '.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['conversationId', 'workspaceDir', 'taskId', 'model', 'effort'].sort());
  assert.equal(record.model, 'other-model'); assert.equal(record.effort, 'max'); assert.equal(record.taskId, last.taskId);
});
test('initialization persists the running session; cancellation and invalid results preserve its continuation entry', async () => {
  const workspace = fixture('early-conversation'), started = await run(workspace, { hang: true, writes: { 'a.txt': 'partial' } }, { asyncMode: true });
  let id = '';
  try {
    await waitFor(() => !!taskTracker.get(started.taskId!)?.result.conversationId);
    const running = taskTracker.report(taskTracker.get(started.taskId!)!); id = running.conversationId!;
    const file = path.join(home, '.gemini', 'antigravity-mcp-conversations-v3', crypto.createHash('sha256').update(id).digest('hex') + '.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(record.taskId, started.taskId); assert.equal(record.workspaceDir, running.executionWorkspaceDir); assert(!('sourceWorkspaceDir' in record));
    assert.equal(record.model, running.model); assert.equal(record.effort, running.effort);
    assert.equal(running.status, 'RUNNING'); assert.equal(running.response, '');
    await waitFor(() => fs.existsSync(path.join(running.executionWorkspaceDir!, 'a.txt')));
    assert.equal((await run(workspace, {}, { conversationId: id })).errorCode, 'WORKSPACE_BUSY');
  } finally { await taskTracker.cancel(started.taskId!); }
  const cancelled = taskTracker.report(taskTracker.get(started.taskId!)!);
  assert.equal(cancelled.conversationId, id); assert.equal(cancelled.activeTool, null); assert.equal(cancelled.activeFile, null); assert.equal(cancelled.recentCommand, null);
  assert.equal(cancelled.lastActivity?.tool, 'view_file'); assert.equal(cancelled.failureStage, 'CLI');
  const resumed = await run(cancelled.executionWorkspaceDir!, { writes: { 'resumed.txt': 'yes' }, omitResult: true }, { conversationId: id });
  assert.equal(resumed.errorCode, 'CLI_OUTPUT_INVALID'); assert.equal(resumed.conversationId, id);
  const again = await run(workspace, {}, { conversationId: id }); assert.equal(again.status, 'SUCCESS'); assert.equal(again.executionWorkspaceDir, cancelled.executionWorkspaceDir);
  assert.equal(fs.readFileSync(path.join(again.executionWorkspaceDir!, 'a.txt'), 'utf8'), 'partial'); assert(fs.existsSync(path.join(workspace, 'a.txt')));
});
test('session errors distinguish missing, corrupt and unreadable records without starting a model or overwriting records', async () => {
  const workspace = fixture('session-diagnostics'), directory = path.join(home, '.gemini', 'antigravity-mcp-conversations-v3');
  fs.mkdirSync(directory, { recursive: true });
  const file = (id: string) => path.join(directory, crypto.createHash('sha256').update(id).digest('hex') + '.json');
  const count = startCount(), unknown = await run(workspace, {}, { conversationId: 'not-registered' });
  assert.equal(unknown.errorCode, 'CONVERSATION_UNKNOWN'); assert.equal(unknown.failureStage, 'INPUT'); assert.equal(unknown.executionStarted, false);
  for (const [id, bytes] of [['corrupt-json', '{invalid'], ['corrupt-schema', '{"conversationId":"corrupt-schema"}']]) {
    fs.writeFileSync(file(id), bytes);
    const legacyDirectory = path.join(home, '.gemini', 'antigravity-mcp-conversations-v2'); fs.mkdirSync(legacyDirectory, { recursive: true });
    fs.writeFileSync(path.join(legacyDirectory, path.basename(file(id))), JSON.stringify({ conversationId: id, workspaceDir: workspace }));
    const result = await run(workspace, {}, { conversationId: id }); assert.equal(result.errorCode, 'CONVERSATION_RECORD_INVALID');
    assert.match(result.errorMessage!, /conversations-v3/); assert.match(result.nextAction!, /保留/); assert.equal(fs.readFileSync(file(id), 'utf8'), bytes);
  }
  sessionManager.save('unreadable', workspace);
  const mutableFs = fs as unknown as { readFileSync: typeof fs.readFileSync }, original = fs.readFileSync;
  mutableFs.readFileSync = ((target: any, options: any) => {
    if (String(target) === file('unreadable')) throw Object.assign(new Error('EACCES: injected session read denial'), { code: 'EACCES' });
    return original(target, options);
  }) as typeof fs.readFileSync;
  try {
    const result = await run(workspace, {}, { conversationId: 'unreadable' }); assert.equal(result.errorCode, 'CONVERSATION_READ_FAILED');
    assert.match(result.errorMessage!, /EACCES/); assert.match(result.nextAction!, /权限/);
  } finally { mutableFs.readFileSync = original; }
  assert.equal(startCount(), count);
});
test('session write failure at initialization reports its cause and stops before releasing the directory', async () => {
  const workspace = fixture('session-save-failure'), mutableFs = fs as unknown as { renameSync: typeof fs.renameSync }, original = fs.renameSync;
  mutableFs.renameSync = (from, to) => {
    if (String(to).includes('antigravity-mcp-conversations-v3')) throw Object.assign(new Error('EACCES: injected session write denial'), { code: 'EACCES' });
    original(from, to);
  };
  let result!: Awaited<ReturnType<typeof run>>;
  try {
    await workerFault('renameSync', 'antigravity-mcp-conversations-v3', async () => {
      result = await run(workspace, { hang: true }, { debugLog: true });
      const finalOnly = await run(fixture('session-save-final-only'), { silent: true, response: 'kept model response' });
      assert.equal(finalOnly.errorCode, 'CONVERSATION_SAVE_FAILED'); assert.equal(finalOnly.failureStage, 'RESULT');
      assert.equal(finalOnly.response, 'kept model response'); assert.deepEqual(finalOnly.usage, { input_tokens: 12, output_tokens: 4 });
    });
  } finally { mutableFs.renameSync = original; }
  assert.equal(result.errorCode, 'CONVERSATION_SAVE_FAILED'); assert.equal(result.failureStage, 'CLI'); assert.equal(result.executionStarted, true);
  assert.match(result.errorMessage!, /EACCES/); assert.match(result.nextAction!, /权限/); assert.equal(result.managedProcess, 'EXITED');
  assert(result.rawLog); assert.equal(result.rawLog.writtenBytes, fs.statSync(result.rawLog.path).size); assert(result.rawLog.writtenBytes > 0);
  assert.equal(acquireWorkspaceLease('save-failure-successor', workspace), true); releaseWorkspaceLease('save-failure-successor');
});
test('same-directory and parent/child leases conflict, then release after cancellation', async () => {
  const workspace = fixture('lease'); fs.mkdirSync(path.join(workspace, 'child'));
  const started = await run(workspace, { hang: true, writes: { 'running.txt': 'yes' } }, { asyncMode: true });
  try {
    await waitFor(() => fs.existsSync(path.join(workspace, 'running.txt')));
    assert.equal((await run(workspace)).errorCode, 'WORKSPACE_BUSY'); assert.equal(acquireWorkspaceLease('child-contender', path.join(workspace, 'child')), false);
  } finally { await taskTracker.cancel(started.taskId!); }
  assert.equal(acquireWorkspaceLease('after-cancel', workspace), true); releaseWorkspaceLease('after-cancel');
});
test('caller timeout and request cancellation leave the accepted task running', async () => {
  const workspace = fixture('caller-timeout'), progress: number[] = [];
  const started = await run(workspace, { delay: 350 }, { requestWaitTimeoutMs: 50, onProgress: async revision => { progress.push(revision); } });
  assert.equal(started.status, 'RUNNING'); const count = progress.length; assert.equal((await final(started.taskId!)).status, 'SUCCESS'); assert.equal(progress.length, count);
  const controller = new AbortController(), pending = run(fixture('request-cancel'), { delay: 200 }, { requestSignal: controller.signal });
  setTimeout(() => controller.abort(), 50); const accepted = await pending; assert.equal(accepted.status, 'RUNNING'); assert.equal((await final(accepted.taskId!)).status, 'SUCCESS');
});

test('default synchronous waiting reaches the real result even when the task is already older than thirty minutes', async () => {
  const workspace = fixture('no-default-wait-deadline'), before = startCount();
  let aged = false;
  const result = await run(workspace, { delay: 400, response: '最终完成' }, {
    requestWaitTimeoutMs: undefined,
    onProgress: async (_revision, message) => {
      if (!aged && message.startsWith('PREPARING: ')) {
        aged = true;
        const task = taskTracker.get(message.split(': ')[1])!;
        task.startedAt -= 31 * 60000; taskTracker.persist(task, true);
      }
    }
  });
  assert(aged); assert.equal(result.status, 'SUCCESS'); assert.equal(result.response, '最终完成');
  assert(result.elapsedSeconds! >= 31 * 60); assert.equal(startCount(), before + 1);
});

test('phase notifications follow observed CLI activity, deduplicate text and tools, and deliver the final result', async () => {
  const notifications: { revision: number; message: string }[] = [];
  const response = '最终报告'.repeat(3000), workspace = fixture('phase-progress');
  const steps = [
    { step_index: 2, step_type: 'agent_response', state: 'ACTIVE', text_delta: '正在分析。' },
    { step_index: 2, step_type: 'agent_response', state: 'ACTIVE', text_delta: '继续分析。' },
    { step_index: 3, step_type: 'tool', tool_name: 'run_command', state: 'ACTIVE', tool_info: { parameters: { CommandLine: 'echo write_to_file' } } },
    { step_index: 3, step_type: 'tool', tool_name: 'run_command', state: 'DONE' },
    { step_index: 4, step_type: 'tool', tool_name: 'write_to_file', state: 'ACTIVE', tool_info: { parameters: { TargetFile: 'a.txt' } } },
    { step_index: 4, step_type: 'tool', tool_name: 'write_to_file', state: 'ACTIVE' },
    { step_index: 4, step_type: 'tool', tool_name: 'write_to_file', state: 'DONE', error: 'edit failed' },
    { step_index: 5, step_type: 'agent_response', state: 'DONE', text_delta: '报告片段。' }
  ];
  const before = startCount();
  const result = await run(workspace, { steps, stepDelay: 250, delay: 350, response }, {
    onProgress: async (revision, message) => { notifications.push({ revision, message }); }
  });
  assert.equal(startCount(), before + 1); assert.equal(result.status, 'SUCCESS'); assert.equal(result.response, response);
  assert.deepEqual(notifications.map(item => item.message.split(': ')[0]), ['PREPARING', 'ANALYZING', 'CODING', 'SUCCESS']);
  assert(notifications.every((item, index) => item.message.includes(result.taskId!) && (index === 0 || item.revision > notifications[index - 1].revision)));
  assert.equal(result.recentTools.find(item => item.stepIndex === 4)?.success, false);
  assert.deepEqual(fs.readdirSync(workspace), []);
});

test('a code call without edit events stays analyzing; asynchronous calls do not retain request notifications', async () => {
  const stages: string[] = [];
  const result = await run(fixture('phase-read-only-code'), { delay: 500 }, {
    onProgress: async (_revision, message) => { stages.push(message.split(': ')[0]); }
  });
  assert.equal(result.status, 'SUCCESS'); assert.deepEqual(stages, ['PREPARING', 'ANALYZING', 'SUCCESS']);
  let count = 0;
  const started = await run(fixture('phase-async'), { delay: 300 }, { asyncMode: true, onProgress: async () => { count++; } });
  assert.equal((await final(started.taskId!)).status, 'SUCCESS'); assert.equal(count, 0);
});

test('error, timeout and cancellation notifications reflect task outcomes without duplicate stages', async () => {
  for (const [name, input, options, expected] of [
    ['error', { error: 'native failure', delay: 500 }, {}, 'ERROR'],
    ['timeout', { hang: true }, { executionTimeoutMs: 3500 }, 'TIMEOUT'],
    ['cancel', { hang: true, writes: { 'a.txt': 'kept' } }, {}, 'CANCELLED']
  ] as const) {
    const stages: string[] = []; let cancellation: ReturnType<typeof taskTracker.cancel> | undefined;
    const workspace = fixture('phase-' + name);
    const result = await run(workspace, input, { ...options, onProgress: async (_revision, message) => {
      const stage = message.split(': ')[0]; stages.push(stage);
      if (name === 'cancel' && stage === 'ANALYZING' && !cancellation) cancellation = taskTracker.cancel(message.split(': ')[1]);
    } });
    await cancellation;
    assert.equal(result.status, expected); assert.equal(stages[0], 'PREPARING'); assert.equal(stages.at(-1), expected);
    assert(stages.every((stage, index) => index === 0 || stage !== stages[index - 1]));
    if (name === 'cancel') assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'kept');
  }
});

test('summary snapshots are strict and bounded while unchanged safety diagnostics remain visible', () => {
  const full = normalizeResult({ status: 'RUNNING', executionStatus: 'RUNNING', taskId: 'summary-example', revision: 39,
    unchanged: true, managedProcess: 'ALIVE', workspaceDir: suite, response: '不要重复发送', latestText: '片段' });
  const minimal = summarizeTask(full);
  assert.deepEqual(minimal, { summary: true, taskId: 'summary-example', status: 'RUNNING', revision: 39, unchanged: true });
  assert(!TaskSummarySchema.safeParse({ ...minimal, response: 'unexpected' }).success);
  const unknown = normalizeResult({ ...full, managedProcess: 'UNKNOWN', errorCode: 'PROCESS_TERMINATION_UNCONFIRMED',
    errorMessage: '中'.repeat(511) + '🙂' + '尾部', nextAction: '检查进程', currentPhase: 'STOPPING' });
  const warning = summarizeTask(unknown);
  assert('summary' in warning); assert.equal(warning.unchanged, true); assert.equal(warning.managedProcess, 'UNKNOWN');
  assert.equal(warning.errorCode, 'PROCESS_TERMINATION_UNCONFIRMED'); assert.equal(warning.errorMessage, '中'.repeat(511));
  assert.equal(warning.nextAction, '检查进程'); TaskSummarySchema.parse(warning);
  const noError = summarizeTask(normalizeResult({ ...full, managedProcess: 'UNKNOWN' }));
  assert('summary' in noError); assert.equal(noError.managedProcess, 'UNKNOWN');
  const changed = summarizeTask(normalizeResult({ ...full, unchanged: false, currentPhase: 'ANALYZING', recentCommand: 'x'.repeat(2048) }));
  assert('summary' in changed); assert.equal(changed.recentCommand?.length, 512);
  assert(!('workspaceDir' in changed) && !('latestText' in changed) && !('recentTools' in changed));
  const completed = normalizeResult({ ...full, status: 'SUCCESS', executionStatus: 'SUCCESS', unchanged: false, response: '完整正文'.repeat(2000) });
  assert.equal(summarizeTask(completed), completed);
  assert.deepEqual(summarizeTask({ ...completed, unchanged: true }), { summary: true, taskId: completed.taskId, status: 'SUCCESS', revision: 39, unchanged: true });
});

test('status summary preserves full defaults, wakes on revisions, returns terminal results and leaves persistence unchanged', async () => {
  const server = createAntigravityServer(), client = new Client({ name: 'summary-contract', version: '3' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  const workspace = fixture('status-summary'), id = 'summary-' + crypto.randomUUID();
  const task = taskTracker.create({ taskId: id, workspaceDir: workspace });
  taskTracker.update(task, { currentPhase: 'ANALYZING', activeTool: 'view_file', activeFile: path.join(workspace, 'a.txt') }, true);
  const before = startCount();
  const query = async (args: Record<string, unknown>) => {
    const output = await client.callTool({ name: 'antigravity_status', arguments: { task_id: id, ...args } });
    assert.deepEqual(JSON.parse((output.content as { text: string }[])[0].text), output.structuredContent);
    return (output.structuredContent as { data: import('../src/utils/register-tool.js').TaskResult | import('../src/utils/register-tool.js').TaskSummary }).data;
  };
  try {
    const full = await query({}); assert(!('summary' in full)); assert.equal(full.workspaceDir, workspace);
    const changed = await query({ view: 'summary' }); assert('summary' in changed); assert.equal(changed.activeTool, 'view_file');
    assert(!('workspaceDir' in changed) && !('response' in changed));
    const quiet = await query({ view: 'summary', after_revision: task.result.revision, wait_ms: 20 });
    assert.deepEqual(quiet, { summary: true, taskId: id, status: 'RUNNING', revision: task.result.revision, unchanged: true });
    const revision = task.result.revision;
    const waiting = query({ view: 'summary', after_revision: revision, wait_ms: 5000 });
    setTimeout(() => taskTracker.update(task, { currentPhase: 'CODING' }), 50);
    const update = await waiting; assert('summary' in update); assert.equal(update.currentPhase, 'CODING'); assert(update.revision > revision);
    const response = '完整中文🙂'.repeat(2000);
    taskTracker.finish(task, { status: 'SUCCESS', executionStatus: 'SUCCESS', response });
    const terminal = await query({ view: 'summary', after_revision: update.revision });
    assert(!('summary' in terminal)); assert.equal(terminal.response, response);
    const unchanged = await query({ view: 'summary', after_revision: terminal.revision });
    assert.deepEqual(unchanged, { summary: true, taskId: id, status: 'SUCCESS', revision: terminal.revision, unchanged: true });
    const final = await query({ view: 'full' }); assert(!('summary' in final)); assert.equal(final.response, response);
    const stored = readTask(id)!; assert(!('summary' in stored.result)); assert.equal(stored.result.response, response);
    assert.equal(startCount(), before); assert.deepEqual(fs.readdirSync(workspace), []);
  } finally {
    if (task.result.status === 'RUNNING') taskTracker.finish(task, { status: 'SUCCESS', executionStatus: 'SUCCESS' });
    await client.close(); await server.close();
  }
});
test('revision queries are read-only and long waits wake on events or request cancellation', async () => {
  const first = await run(fixture('polling'), { delay: 600 }, { asyncMode: true }), task = taskTracker.get(first.taskId!)!, revision = task.result.revision;
  const report = taskTracker.report(task, true); assert.equal(report.revision, revision); assert.equal(report.unchanged, true);
  await taskTracker.waitForRevision(first.taskId!, revision, 15000); assert(task.result.revision > revision);
  const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
  await taskTracker.waitForRevision(first.taskId!, task.result.revision, 10000, controller.signal);
  assert.equal(task.result.status, 'RUNNING'); assert.equal((await final(first.taskId!)).status, 'SUCCESS');
});
test('execution deadline stops a writing task and retains edits; preparation timeout starts no model', async () => {
  const workspace = fixture('execution-timeout'), result = await run(workspace, { hang: true, writes: { 'a.txt': 'kept' } }, { executionTimeoutMs: 3500 });
  assert.equal(result.status, 'TIMEOUT'); assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'kept');
  const count = startCount(), preparation = await run(fixture('preparation-timeout'), {}, { analysis: true, executionTimeoutMs: 0.0001 });
  assert.equal(preparation.status, 'TIMEOUT'); assert.equal(preparation.executionStarted, false); assert.equal(startCount(), count);
});


test('cancel is idempotent, keeps partial edits and stops detached descendants', async () => {
  const workspace = fixture('cancel-descendants'), started = await run(workspace, { hang: true, descendants: true, writes: { 'a.txt': 'kept' } }, { asyncMode: true });
  await waitFor(() => fs.existsSync(path.join(workspace, 'descendant.pid'))); const pid = Number(fs.readFileSync(path.join(workspace, 'descendant.pid'), 'utf8'));
  const cancelled = await taskTracker.cancel(started.taskId!); assert.equal(cancelled?.result.status, 'CANCELLED'); assert.equal(await isProcessAlive(pid), false);
  const before = taskTracker.report(cancelled!); await taskTracker.cancel(started.taskId!); assert.deepEqual(taskTracker.report(cancelled!), before);
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'kept');
});
test('normal completion stops grandchildren whose intermediate parent already exited', async () => {
  const workspace = fixture('grandchildren'), result = await run(workspace, { descendants: true, grandchild: true }); assert.equal(result.status, 'SUCCESS');
  for (const name of ['descendant.pid', 'grandchild.pid']) assert.equal(await isProcessAlive(Number(fs.readFileSync(path.join(workspace, name), 'utf8'))), false);
});
test('unconfirmed termination holds its lease until cancellation can confirm exit', async () => {
  const workspace = fixture('pending-stop'), task = taskTracker.create({ taskId: 'pending-stop', workspaceDir: workspace, executionWorkspaceDir: workspace });
  assert.equal(acquireWorkspaceLease('pending-stop', workspace), true);
  taskTracker.update(task, { currentPhase: 'STOPPING', executionStatus: 'PROCESS_TERMINATION_UNCONFIRMED', errorCode: 'PROCESS_TERMINATION_UNCONFIRMED' });
  assert.equal(acquireWorkspaceLease('contender', workspace), false); await taskTracker.cancel('pending-stop'); assert.equal(task.result.status, 'CANCELLED');
  assert.equal(acquireWorkspaceLease('contender', workspace), true); releaseWorkspaceLease('contender');
});
test('raw logs retain long reports and event parsing continues after the logging cap', async () => {
  const response = '中文报告'.repeat(3000), result = await run(fixture('logs'), { flood: true, response }, { debugLog: true });
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.response, response); assert(result.rawLog?.truncated);
  const bytes = fs.readFileSync(result.rawLog.path); assert(bytes.length <= result.rawLog.maxBytes); assert.match(bytes.toString(), /RAW_STDOUT_LOG_TRUNCATED/);
  const complete = await run(fixture('complete-log'), { response }, { debugLog: true }); assert(complete.rawLog);
  assert.equal(complete.response, response); assert(fs.readFileSync(complete.rawLog.path, 'utf8').includes(response)); assert.equal(complete.rawLog.truncated, false);
});
test('debug logging is opt-in and disabled logging cannot truncate final output or stderr diagnostics', async () => {
  const directory = path.join(home, '.gemini', 'antigravity-mcp-logs'), before = fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
  const response = '完整中文🙂报告'.repeat(1000), result = await run(fixture('no-debug-log'), { flood: true, response, stderr: 'diagnostic '.repeat(1000) });
  assert.equal(result.status, 'SUCCESS', result.errorMessage ?? ''); assert.equal(result.rawLog, null); assert.equal(result.response, response);
  assert(result.stderrTail.length <= 8192); assert.match(result.stderrTail, /diagnostic/); assert.deepEqual(fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [], before);
});
test('recent tools pair and deduplicate operations, retain only five and do not treat DONE as success', async () => {
  const steps: object[] = [];
  for (let step_index = 2; step_index <= 8; step_index++) {
    const step = { step_index, step_type: 'tool', tool_name: 'run_command', state: 'ACTIVE', tool_info: { parameters: { CommandLine: 'node step-' + step_index } } };
    steps.push(step, step, { ...step, tool_info: { parameters: { CommandLine: 'node step-' + step_index, TargetFile: 'step-' + step_index + '.txt' } } });
    const ended = { ...step, state: 'DONE', ...(step_index === 7 ? { error: 'failed command' } : step_index === 8 ? { success: true } : {}) };
    steps.push(ended, ended);
  }
  const result = await run(fixture('recent-tools'), { steps });
  assert.deepEqual(result.recentTools.map(item => item.stepIndex), [4, 5, 6, 7, 8]);
  assert.equal(new Set(result.recentTools.map(item => item.stepId)).size, 5);
  assert(result.recentTools.every(item => item.state === 'DONE' && item.file === 'step-' + item.stepIndex + '.txt'));
  assert.deepEqual(result.recentTools.map(item => item.success), [null, null, null, false, true]);
  assert.equal(result.activeFile, null); assert.equal(result.recentCommand, null);
});
test('a current command does not inherit a previous operation file and tool history remains bounded while running', async () => {
  const step = { step_index: 2, step_type: 'tool', tool_name: 'run_command', state: 'ACTIVE', tool_info: { parameters: { CommandLine: 'node current.cjs' } } };
  const started = await run(fixture('current-tool'), { steps: [step], hang: true }, { asyncMode: true });
  try {
    await waitFor(() => taskTracker.get(started.taskId!)?.result.activeTool === 'run_command');
    const running = taskTracker.report(taskTracker.get(started.taskId!)!);
    assert.equal(running.activeFile, null); assert.equal(running.recentCommand, 'node current.cjs'); assert.equal(running.lastActivity?.file, null);
  } finally { await taskTracker.cancel(started.taskId!); }
});
test('model text accumulates deltas, resets for a new response step and keeps the full final result', async () => {
  const current = '本轮🙂'.repeat(1200) + '末尾中文\n', response = '最终完整报告'.repeat(3000);
  const steps = [
    { step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: '前一段文字' },
    { step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: current.slice(0, -5) },
    { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: current.slice(-5) },
    { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: current.slice(-5) }
  ];
  const result = await run(fixture('text-deltas'), { steps, response });
  assert.equal(result.latestText, current.slice(-4000)); assert.equal(result.response, response); assert.equal(result.status, 'SUCCESS');
  assert(!result.latestText.includes('前一段文字'));
});
test('bounded model text never starts with half of a UTF-16 emoji', async () => {
  const current = '🙂'.repeat(2001) + '。';
  const result = await run(fixture('text-emoji-boundary'), { steps: [{ step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: current }] });
  assert.equal(result.latestText, current.slice(-3999)); assert.equal(Buffer.from(result.latestText).toString('utf8'), result.latestText);
});
test('Chinese and shell characters reach the CLI unchanged; report-schema flags are removed', async () => {
  const workspace = fixture('参数 中文'), capture = path.join(workspace, 'args.json'), context = '中文 "引号" \\路径 & $() \u0060原文\u0060';
  const result = await run(workspace, { capture }, { context }); assert.equal(result.status, 'SUCCESS');
  const args = JSON.parse(fs.readFileSync(capture, 'utf8')).args; assert(args[args.indexOf('-p') + 1].includes(context));
  assert(!args.includes('--json-schema')); assert(args.includes('--disable-slash-commands'));
});
test('field, escaped command-line and NUL limits reject before startup', async () => {
  const workspace = fixture('input-limits'), count = startCount();
  assert.equal((await run(workspace, {}, { prompt: 'x'.repeat(24001) })).errorCode, 'INVALID_ARGUMENT');
  assert.equal((await run(workspace, {}, { context: '中'.repeat(20001) })).errorCode, 'INVALID_ARGUMENT');
  const largeInput = { prompt: 'x'.repeat(24000), context: '中'.repeat(20000) };
  // Windows 的整体命令行上限不适用于 POSIX；通过平台注入保留两种契约的断言。
  assert.throws(() => validateCommandLine(process.execPath, [cli, largeInput.prompt, largeInput.context], 'win32'), /INPUT_TOO_LARGE/);
  assert.doesNotThrow(() => validateCommandLine(process.execPath, [cli, largeInput.prompt, largeInput.context], 'linux'));
  if (process.platform === 'win32') assert.equal((await run(workspace, {}, largeInput)).errorCode, 'INPUT_TOO_LARGE');
  assert.equal((await run(workspace, {}, { prompt: 'nul\0value' })).errorCode, 'INVALID_ARGUMENT');
  assert.equal((await run(workspace, {}, { verificationCommands: ['node\0bad'] } as unknown as Partial<Options>)).errorCode, 'INVALID_ARGUMENT'); assert.equal(startCount(), count);
  assert.doesNotThrow(() => validateCommandLine('x', ['a'.repeat(29998)], 'win32'));
  assert.throws(() => validateCommandLine('x', ['a'.repeat(29999)], 'win32'), /INPUT_TOO_LARGE/);
});
test('retired rewind mode and a missing working directory reject before any CLI execution', async () => {
  const workspace = fixture('retired-rewind'), count = startCount();
  const retired = await run(workspace, {}, { rewind: true } as unknown as Partial<Options>);
  assert.equal(retired.errorCode, 'INVALID_ARGUMENT'); assert.equal(retired.executionStarted, false);
  const missing = await run(workspace, {}, { workspaceDir: undefined });
  assert.equal(missing.errorCode, 'INVALID_ARGUMENT'); assert.equal(missing.executionStarted, false);
  assert.equal(startCount(), count);
});
test('task records survive a new tracker; elapsed queries and heartbeats do not manufacture revisions', () => {
  const tracker = new TaskTracker(), task = tracker.create({ taskId: 'memory-task', workspaceDir: suite });
  task.startedAt -= 125000; const revision = task.result.revision; let notifications = 0;
  const unsubscribe = tracker.subscribe('memory-task', () => notifications++);
  tracker.output(task); const observed = tracker.report(task); unsubscribe();
  assert(observed.elapsedSeconds !== null && observed.elapsedSeconds >= 125); assert.equal(observed.revision, revision); assert.equal(notifications, 0);
  assert.equal(task.result.revision, revision); assert.equal(new TaskTracker().get('memory-task')?.result.revision, revision);
  tracker.heartbeat(task); assert.equal(new TaskTracker().get('memory-task')?.result.revision, revision);
  tracker.finish(task, { status: 'SUCCESS', executionStatus: 'SUCCESS' }); assert.equal(tracker.get('memory-task')?.result.status, 'SUCCESS');
  assert.equal(new TaskTracker().get('memory-task')?.result.status, 'SUCCESS');
});
test('completed task cache evicts old records without evicting an active task', () => {
  const tracker = new TaskTracker(), active = tracker.create({ taskId: 'cache-active', workspaceDir: suite });
  for (let index = 0; index < 105; index++) {
    const task = tracker.create({ taskId: 'cache-' + index, workspaceDir: suite }); tracker.finish(task, { status: 'SUCCESS', executionStatus: 'SUCCESS' });
  }
  assert.equal(tracker.get('cache-0'), undefined); assert.equal(tracker.get('cache-active'), active); assert.equal(tracker.get('cache-104')?.result.status, 'SUCCESS');
  tracker.finish(active, { status: 'SUCCESS', executionStatus: 'SUCCESS' });
});
test('old task archives are neither loaded nor changed by new execution', async () => {
  const directory = path.join(home, '.gemini', 'antigravity-mcp-tasks-v3'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'historical.json'), bytes = '{old archived bytes'; fs.writeFileSync(file, bytes);
  assert.equal(new TaskTracker().get('historical'), undefined);
  const result = await run(fixture('history-preserved')); assert.equal(result.status, 'SUCCESS');
  assert.equal(new TaskTracker().get(result.taskId!)?.result.status, 'SUCCESS'); assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.deepEqual(fs.readdirSync(directory), ['historical.json']);
});










test('killing the submitting process leaves its worker queryable and cancellable before explicit continuation', async () => {
  const workspace = fixture('owner-interrupted-source'), runner = path.join(suite, 'owner-interruption.mjs'); write(workspace, 'a.txt', 'source');
  fs.writeFileSync(runner, "import os from 'node:os';os.homedir=()=>" + JSON.stringify(home) +
    ";const {executeAgy}=await import(" + JSON.stringify(pathToFileURL(path.resolve('src/agy-executor.ts')).href) + ");" +
    "const result=await executeAgy({prompt:" + JSON.stringify('FIXTURE:' + JSON.stringify({ hang: true, writes: { 'a.txt': 'partial' } })) +
    ",workspaceDir:" + JSON.stringify(workspace) + ",model:'saved-model',effort:'max',asyncMode:true,cliPath:process.execPath,cliArgsPrefix:[" + JSON.stringify(cli) + "]});" +
    "console.log('OWNER_TASK:'+JSON.stringify(result));setInterval(()=>{},1000);");
  const owner = spawn(process.execPath, ['--import', 'tsx', runner], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; owner.stdout.on('data', chunk => stdout += chunk); owner.stderr.on('data', chunk => stderr += chunk);
  let acceptedId: string | undefined;
  try {
    await waitFor(() => { if (owner.exitCode !== null) throw new Error(stderr); return stdout.includes('OWNER_TASK:'); });
    const accepted = JSON.parse(stdout.split('\n').find(line => line.startsWith('OWNER_TASK:'))!.slice('OWNER_TASK:'.length));
    acceptedId = accepted.taskId;
    const records = path.join(home, '.gemini', 'antigravity-mcp-conversations-v3');
    let record: { conversationId: string; model: string; effort: string } | undefined;
    await waitFor(() => {
      record = (fs.existsSync(records) ? fs.readdirSync(records) : []).filter(name => name.endsWith('.json')).map(name => {
        try { return JSON.parse(fs.readFileSync(path.join(records, name), 'utf8')); } catch { return undefined; }
      }).find(value => value?.taskId === accepted.taskId);
      return !!record && fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8') === 'partial';
    });
    owner.kill('SIGKILL'); await waitFor(() => owner.exitCode !== null || owner.signalCode !== null);
    const count = startCount(), fresh = new TaskTracker(); assert.equal(fresh.get(accepted.taskId)?.result.status, 'RUNNING'); assert.equal(startCount(), count);
    assert.equal((await fresh.cancel(accepted.taskId))?.result.status, 'CANCELLED');
    const resumed = await run(workspace, { writes: { 'continued.txt': 'yes' } }, { conversationId: record!.conversationId });
    assert.equal(resumed.status, 'SUCCESS'); assert.equal(resumed.executionWorkspaceDir, workspace); assert.equal(resumed.conversationId, record!.conversationId);
    assert.equal(resumed.model, 'saved-model'); assert.equal(resumed.effort, 'max');
    assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'partial'); assert.equal(fs.readFileSync(path.join(workspace, 'continued.txt'), 'utf8'), 'yes');
  } finally {
    if (acceptedId) await new TaskTracker().cancel(acceptedId);
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
  }
});

test('Windows worker survives host Job closure and parent tree termination without losing directory control', { skip: process.platform !== 'win32' }, async () => {
  for (const shutdown of ['job-close', 'tree-kill']) {
    const workspace = fixture('host-' + shutdown + '-中文'), acceptedFile = path.join(workspace, 'accepted.json'), capture = path.join(workspace, 'capture.json');
    const options = { prompt: 'FIXTURE:' + JSON.stringify({ capture, hang: true, descendants: true, grandchild: true, writes: { 'a.txt': 'kept' } }),
      workspaceDir: workspace, asyncMode: true, executionTimeoutMs: 30000, cliPath: process.execPath, cliArgsPrefix: [cli] };
    const runner = write(suite, 'host-' + shutdown + '.mjs', "import fs from 'node:fs';import os from 'node:os';os.homedir=()=>" + JSON.stringify(home) +
      ";process.env.TEST_WORKER_TEXT='中文🙂 & $ literal';const {executeAgy}=await import(" + JSON.stringify(pathToFileURL(path.resolve('src/agy-executor.ts')).href) +
      ");const result=await executeAgy(" + JSON.stringify(options) + ");" +
      "const end=Date.now()+10000;while(!fs.existsSync(" + JSON.stringify(path.join(workspace, 'grandchild.pid')) + ")&&Date.now()<end)await new Promise(r=>setTimeout(r,20));" +
      "fs.writeFileSync(" + JSON.stringify(acceptedFile) + ",JSON.stringify({taskId:result.taskId,ownerPid:process.pid}));" +
      (shutdown === 'job-close' ? 'process.exit(0);' : 'setInterval(()=>{},1000);'));
    const abort = new AbortController(), count = startCount();
    const host = runManagedProcess(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, runner], { cwd: process.cwd(), signal: abort.signal });
    let id: string | undefined;
    try {
      await waitFor(() => fs.existsSync(acceptedFile));
      const accepted = JSON.parse(fs.readFileSync(acceptedFile, 'utf8')) as { taskId: string; ownerPid: number }; id = accepted.taskId;
      if (shutdown === 'tree-kill') assert.equal((await killProcessTree(accepted.ownerPid)).verifiedTerminated, true);
      const output = await host; assert.equal(output.stopped, true, output.stderr);
      if (shutdown === 'job-close') assert.equal(output.exitCode, 0, output.stderr);
      await new Promise(resolve => setTimeout(resolve, 200));
      const fresh = new TaskTracker(), task = fresh.get(id)!;
      assert.equal(task.result.status, 'RUNNING', task.result.errorMessage ?? ''); assert.equal(await isProcessAlive(accepted.ownerPid), false);
      assert(task.workerPid); assert.equal(await isProcessAlive(task.workerPid), true); assert.equal(startCount(), count + 1);
      assert.equal(acquireWorkspaceLease('blocked-' + shutdown, workspace), false);
      const captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
      assert.equal(captured.cwd, workspace); assert.equal(captured.user, os.userInfo().username); assert.equal(captured.envProbe, '中文🙂 & $ literal');
      const grandchild = Number(fs.readFileSync(path.join(workspace, 'grandchild.pid'), 'utf8')); assert.equal(await isProcessAlive(grandchild), true);
      assert.equal((await fresh.cancel(id))?.result.status, 'CANCELLED');
      await waitFor(async () => !await isProcessAlive(task.workerPid!));
      assert.equal(await isProcessAlive(grandchild), false); assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'kept');
      assert.equal(acquireWorkspaceLease('successor-' + shutdown, workspace), true); releaseWorkspaceLease('successor-' + shutdown);
    } finally {
      abort.abort('TEST_CLEANUP'); await host;
      if (id) await new TaskTracker().cancel(id);
    }
  }
});
test('Windows worker creation errors are explicit and do not start a model', { skip: process.platform !== 'win32' }, async () => {
  const count = startCount();
  await assert.rejects(startWindowsWorker(path.join(suite, 'missing-worker.exe'), [], suite, process.env), /WORKER_START_FAILED: Windows process creation returned/);
  assert.equal(startCount(), count);
});
test('config stays read-only and rejects removed migration/cache fields', () => {
  const config = path.join(suite, 'config.json'), bytes = '{"defaultModel":"gemini-3.8-flash-high","defaultEffort":"high"}';
  fs.writeFileSync(config, bytes); assert.deepEqual(new ConfigManager(config).getConfig(), JSON.parse(bytes)); assert.equal(fs.readFileSync(config, 'utf8'), bytes);
  for (const defaultEffort of ['xhigh', 'max']) {
    fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(bytes), defaultEffort })); assert.equal(new ConfigManager(config).getConfig().defaultEffort, defaultEffort);
  }
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(bytes), volatilePaths: ['cache.db'] })); assert.throws(() => new ConfigManager(config), /INVALID_CONFIG/);
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(bytes), defaultRequestWaitMinutes: 30 })); assert.throws(() => new ConfigManager(config), /INVALID_CONFIG/);
});
test('worker crash stops its process job and preserves session, files and the last elapsed time', {
  skip: process.platform !== 'win32' ? '依赖 Windows Job Object 及 worker 退出监视；POSIX 没有 worker 崩溃后的自动后代清理' : false
}, async () => {
  const workspace = fixture('worker-crash'), started = await run(workspace, { hang: true, descendants: true, grandchild: true, writes: { 'a.txt': 'partial' } }, { asyncMode: true });
  await waitFor(() => fs.existsSync(path.join(workspace, 'grandchild.pid')) && !!taskTracker.get(started.taskId!)?.result.conversationId);
  const descendants = ['descendant.pid', 'grandchild.pid'].map(name => Number(fs.readFileSync(path.join(workspace, name), 'utf8')));
  await new Promise(resolve => setTimeout(resolve, 1100));
  const record = readTask(started.taskId!)!, count = startCount(); assert(record.workerPid);
  process.kill(record.workerPid, 'SIGKILL');
  const fresh = new TaskTracker();
  await waitFor(() => fresh.get(started.taskId!)?.result.status === 'ERROR');
  const stopped = fresh.report(fresh.get(started.taskId!)!);
  assert.equal(stopped.errorCode, 'WORKER_INTERRUPTED'); assert(stopped.conversationId);
  assert(stopped.elapsedSeconds !== null && stopped.elapsedSeconds >= 1); assert.equal(stopped.activeTool, null);
  assert.equal(stopped.elapsedSeconds, fresh.report(fresh.get(started.taskId!)!).elapsedSeconds);
  assert.equal(startCount(), count); assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'partial');
  for (const pid of descendants) assert.equal(await isProcessAlive(pid), false);
  assert.equal(acquireWorkspaceLease('crash-successor', workspace), true); releaseWorkspaceLease('crash-successor');
});
test('corrupt durable records fail explicitly without launching or overwriting a task', async () => {
  const result = await run(fixture('record-corruption')), file = taskFile(result.taskId!), bytes = fs.readFileSync(file, 'utf8'), count = startCount();
  fs.writeFileSync(file, '{damaged');
  try { assert.throws(() => new TaskTracker().get(result.taskId!), /TASK_RECORD_INVALID/); assert.equal(fs.readFileSync(file, 'utf8'), '{damaged'); assert.equal(startCount(), count); }
  finally { fs.writeFileSync(file, bytes); }
});
test('durable state and lease handoff failures reject without starting a model or leaving a directory occupied', async () => {
  const original = fs.renameSync, count = startCount();
  for (const needle of ['antigravity-mcp-jobs-v1', 'antigravity-mcp-leases']) {
    const workspace = fixture('startup-refusal-' + needle);
    fs.renameSync = (from, to) => {
      if (String(to).includes(needle)) throw Object.assign(new Error('EACCES: injected startup refusal'), { code: 'EACCES' });
      original(from, to);
    };
    let result: Awaited<ReturnType<typeof run>>;
    try { result = await run(workspace); } finally { fs.renameSync = original; }
    assert.equal(result.status, 'ERROR'); assert.equal(result.executionStarted, false); assert.equal(startCount(), count);
    assert.equal(acquireWorkspaceLease('startup-successor', workspace), true); releaseWorkspaceLease('startup-successor');
  }
});
test('MCP exposes four tools, rejects retired inputs and returns identical JSON text and structured content', async () => {
  const server = createAntigravityServer(), client = new Client({ name: 'contract', version: '3' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  try {
    const tools = (await client.listTools()).tools; assert.deepEqual(tools.map(tool => tool.name).sort(),
      ['antigravity_ask', 'antigravity_code', 'antigravity_status', 'antigravity_cancel_task'].sort()); assert(tools.every(tool => tool.outputSchema));
    const ask = tools.find(tool => tool.name === 'antigravity_ask')!;
    assert.equal(ask.annotations?.readOnlyHint, false); assert.equal(ask.annotations?.destructiveHint, true);
    assert(ask.inputSchema.properties?.cli_mode); assert(ask.inputSchema.properties?.auto_approve); assert(ask.inputSchema.properties?.debug_log);
    for (const tool of tools.filter(tool => ['antigravity_ask', 'antigravity_code'].includes(tool.name))) {
      assert.equal((tool.inputSchema.properties?.auto_approve as { default?: boolean }).default, true);
      assert(!tool.inputSchema.required?.includes('auto_approve'));
    }
    assert(tools.every(tool => !tool.inputSchema.properties?.agent && !tool.inputSchema.properties?.verification_commands));
    for (const key of ['verification_commands', 'agent', 'workspace_mode', 'source_files', 'task_scope', 'no_touch', 'max_changed_files', 'dry_run', 'prepared_workspace_id', 'prior_findings', 'constraints', 'acceptance_criteria']) {
      const output = await client.callTool({ name: 'antigravity_code', arguments: { prompt: 'test', workspace_dir: suite, [key]: true } });
      assert.equal((output.structuredContent as Record<string, unknown>).errorCode, 'INVALID_ARGUMENT'); assert.deepEqual(JSON.parse((output.content as { text: string }[])[0].text), output.structuredContent);
    }
    for (const name of ['antigravity_prepare_workspace', 'antigravity_rewind', 'antigravity_quota', 'antigravity_check_task']) {
      const removed = await client.callTool({ name, arguments: {} });
      assert.equal((removed.structuredContent as Record<string, unknown>).errorCode, 'TOOL_NOT_FOUND');
      assert.deepEqual(JSON.parse((removed.content as { text: string }[])[0].text), removed.structuredContent);
    }
    assert(tools.every(tool => !tool.outputSchema?.properties?.rewind));
    const missing = await client.callTool({ name: 'antigravity_status', arguments: { task_id: 'missing' } });
    const envelope = missing.structuredContent as { kind: string; data: import('../src/utils/register-tool.js').TaskResult };
    assert.equal(envelope.kind, 'task'); assert.equal(envelope.data.errorCode, 'TASK_NOT_FOUND');
    assert.equal(envelope.data.failureStage, 'QUERY'); assert(envelope.data.nextAction); assert.deepEqual(JSON.parse((missing.content as { text: string }[])[0].text), envelope);
    assert(tools.find(tool => tool.name === 'antigravity_status')!.inputSchema.properties?.view);
    for (const arguments_ of [{ after_revision: 1 }, { wait_ms: 10 }, { view: 'summary' }, { view: 'full' }, { unknown: true }, { task_id: 'missing', view: 'invalid' }, { task_id: 'missing', unknown: true }]) {
      const output = await client.callTool({ name: 'antigravity_status', arguments: arguments_ });
      const payload = output.structuredContent as { kind: string; data: { errorCode: string } };
      assert.equal(payload.kind, 'task_id' in arguments_ ? 'task' : 'quota'); assert.equal(payload.data.errorCode, 'INVALID_ARGUMENT');
      assert.deepEqual(JSON.parse((output.content as { text: string }[])[0].text), payload);
    }
  } finally { await client.close(); await server.close(); }
});

test('legacy session files stay untouched while continuation saves a new v3 record', async () => {
  const source = fixture('legacy-source'), execution = fixture('legacy-execution'), id = 'legacy-conversation';
  const crypto = await import('node:crypto'), name = crypto.createHash('sha256').update(id).digest('hex') + '.json';
  const directory = path.join(home, '.gemini', 'antigravity-mcp-conversations-v2'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name), bytes = JSON.stringify({ conversationId: id, workspaceDir: execution,
    sourceWorkspaceDir: source, workspaceMode: 'isolated', sourceFingerprint: 'old-fingerprint', priorFindings: [{ evidence: 'historical' }], updatedAt: 1 });
  fs.writeFileSync(file, bytes);
  const result = await run(source, {}, { analysis: true, conversationId: id });
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.executionWorkspaceDir, execution); assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert(fs.existsSync(path.join(home, '.gemini', 'antigravity-mcp-conversations-v3', name)));
});
test('report keywords and suggestions never alter execution status', async () => {
  for (const response of ['建议：当用户已修复代码后，应重新检查。',
    'No files were modified. This is a suggested fix.',
    'The reviewed code mentions PROCESS_TERMINATION_UNCONFIRMED.']) {
    assert.equal((await run(fixture('report-' + startCount()), { response })).status, 'SUCCESS');
  }
});
test('tracking callback failure stops the launched process instead of orphaning it', async () => {
  let pid = 0;
  const result = await runManagedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    onSpawn: value => { pid = value; throw new Error('tracking failed'); }
  });
  assert.equal(result.stopped, true); assert.match(result.error!, /PROCESS_TRACKING_FAILED/); assert.equal(await isProcessAlive(pid), false);
});
test('cross-process leases reject overlapping work and reclaim a dead owner', async () => {
  const workspace = fixture('cross-process'), runner = path.join(suite, 'lease-holder.mjs');
  fs.writeFileSync(runner, "import os from 'node:os';os.homedir=()=>" + JSON.stringify(home) +
    ";const {acquireWorkspaceLease}=await import(" + JSON.stringify(pathToFileURL(path.resolve('src/utils/workspace-lease.ts')).href) +
    ");console.log(acquireWorkspaceLease('holder'," + JSON.stringify(workspace) + ")?'ACQUIRED':'FAILED');setInterval(()=>{},1000);");
  const child = spawn(process.execPath, ['--import', 'tsx', runner], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', chunk => stdout += chunk);
  try { await waitFor(() => stdout.includes('ACQUIRED')); assert.equal(acquireWorkspaceLease('contender', workspace), false); }
  finally { await killProcessTree(child.pid!); }
  assert.equal(acquireWorkspaceLease('contender', workspace), true); releaseWorkspaceLease('contender');
});


test('production stdio uses a fake executable for code, direct ask, continuation, progress and cancellation', { skip: process.platform !== 'win32' }, async () => {
  const source = path.join(suite, 'fake-native.cs'), executable = path.join(suite, 'fake-native.exe'), compiler = path.join(suite, 'compile.ps1');
  fs.writeFileSync(source, [
    'using System; using System.IO; using System.Text; using System.Diagnostics; using System.Threading;',
    'public class Program { public static void Main(string[] args) {',
    'Console.OutputEncoding=new UTF8Encoding(false); int p=Array.IndexOf(args,"-p"); string prompt=p<0?"":args[p+1];',
    'if(prompt=="/usage"){Console.WriteLine("{\\"event\\":\\"result\\",\\"result\\":{\\"status\\":\\"SUCCESS\\",\\"response\\":\\"quota\\",\\"conversation_id\\":\\"\\",\\"command\\":{\\"name\\":\\"usage\\",\\"data\\":{\\"groups\\":[{\\"name\\":\\"Gemini Models\\",\\"buckets\\":[{\\"id\\":\\"gemini-weekly\\",\\"name\\":\\"Weekly\\",\\"window\\":\\"weekly\\",\\"remaining_fraction\\":0.9,\\"reset_time\\":\\"2050-10-13T14:27:34Z\\"}]}]}}}} ");return;}',
    'File.WriteAllLines("invocation.args",args);',
    'int c=Array.IndexOf(args,"--conversation"); string id=c<0?Guid.NewGuid().ToString():args[c+1];',
    'Console.WriteLine("{\\"event\\":\\"init\\",\\"conversation_id\\":\\""+id+"\\"}");',
    'Console.WriteLine("{\\"event\\":\\"step_update\\",\\"step_update\\":{\\"step_index\\":1,\\"state\\":\\"ACTIVE\\",\\"step_type\\":\\"tool\\",\\"tool_name\\":\\"view_file\\",\\"tool_info\\":{\\"parameters\\":{\\"TargetFile\\":\\"a.txt\\"}}}}");',
    'int mode=Array.IndexOf(args,"--mode"); if(mode>=0 && args[mode+1]!="plan")File.WriteAllText("a.txt","generated");',
    'if(prompt.Contains("HANG")) {var info=new ProcessStartInfo(Environment.GetEnvironmentVariable("TEST_NODE"),"-e \\"setInterval(()=>{},1000)\\"");info.UseShellExecute=false;info.CreateNoWindow=true;var child=Process.Start(info);File.WriteAllText("child.pid",child.Id.ToString());while(true)Thread.Sleep(1000);}',
    'if(prompt.Contains("DELAY"))Thread.Sleep(1500);',
    'Console.WriteLine("{\\"event\\":\\"step_update\\",\\"step_update\\":{\\"step_index\\":1,\\"state\\":\\"DONE\\",\\"step_type\\":\\"tool\\",\\"tool_name\\":\\"view_file\\"}}");',
    'Console.WriteLine("{\\"event\\":\\"result\\",\\"result\\":{\\"status\\":\\"SUCCESS\\",\\"response\\":\\"Native task complete.\\",\\"conversation_id\\":\\""+id+"\\",\\"usage\\":{\\"input_tokens\\":9,\\"output_tokens\\":3}}}");',
    '}}'
  ].join('\n'));
  fs.writeFileSync(compiler, '$ErrorActionPreference="Stop";Add-Type -Path $args[0] -OutputAssembly $args[1] -OutputType ConsoleApplication');
  const compiled = await runManagedProcess(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-File', compiler, source, executable], { timeoutMs: 15000 });
  assert.equal(compiled.exitCode, 0, compiled.stderr);
  const clientHome = fixture('client-home'), workspace = fixture('native-workspace 中文');
  write(workspace, 'a.txt', 'source');
  const connect = async () => {
    const client = new Client({ name: 'native-stdio', version: '3' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/index.js')],
      // 只隔离 MCP 状态，不伪造 Windows 用户配置目录。
      env: { AGY_PATH: executable, ANTIGRAVITY_MCP_STATE_HOME: clientHome, TEST_NODE: process.execPath }, stderr: 'pipe' });
    await client.connect(transport); return { client, transport };
  };
  const data = (result: unknown) => {
    const value = result as { content: { text: string }[]; structuredContent: Record<string, unknown> };
    assert.deepEqual(JSON.parse(value.content[0].text), value.structuredContent);
    return (value.structuredContent.kind === 'task' ? value.structuredContent.data : value.structuredContent) as import('../src/utils/register-tool.js').TaskResult;
  };
  const cancellationDiagnostic = (result: ReturnType<typeof data>) => {
    if (result.status === 'CANCELLED') return JSON.stringify(result);
    let record: Record<string, unknown> | undefined, processes: string | undefined;
    try {
      record = JSON.parse(fs.readFileSync(path.join(clientHome, '.gemini', 'antigravity-mcp-jobs-v1', result.taskId! + '.task.json'), 'utf8'));
      delete record!.token;
      const ids = [record!.workerPid, ...record!.childPids as number[]].filter(value => Number.isSafeInteger(value) && Number(value) > 0);
      const script = String.raw`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
Import-Module ($PSHOME + '\Modules\CimCmdlets\CimCmdlets.psd1')
$rows = @(foreach ($candidate in ($env:AGY_TEST_PROCESS_IDS -split ',')) {
  try {
    $process = [Diagnostics.Process]::GetProcessById([int]$candidate)
    try {
      $native = $process.StartTime.ToUniversalTime()
      $cim = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $candidate)
      @{ pid=[int]$candidate; nativeCreatedAt=$native.ToFileTimeUtc().ToString(); nativeUtc=$native.ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ'); cimUtc=$(if ($cim) { $cim.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') } else { $null }) }
    } finally { $process.Dispose() }
  } catch { @{ pid=[int]$candidate; error=$_.Exception.Message } }
})
[Console]::Out.Write((ConvertTo-Json -InputObject $rows -Compress -Depth 5))`;
      processes = execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 8192,
          env: { ...process.env, AGY_TEST_PROCESS_IDS: ids.join(',') } }).trim();
    } catch (error) { processes = String(error); }
    return JSON.stringify({ result, record, processes });
  };
  const connection = await connect(), progress: { progress: number; total?: number }[] = [];
  let savedCode: ReturnType<typeof data> | undefined;
  try {
    assert.equal((await connection.client.listTools()).tools.length, 4);
    const code = data(await connection.client.callTool({ name: 'antigravity_code', arguments: {
      prompt: 'WRITE', workspace_dir: workspace } }, undefined,
      { onprogress: value => progress.push(value) }));
    assert.equal(code.status, 'SUCCESS', JSON.stringify(code)); assert(!('verification' in code)); assert.equal(code.rawLog, null); assert(code.conversationId);
    assert(!('quota' in code));
    const quotaOutput = await connection.client.callTool({ name: 'antigravity_status', arguments: {} });
    assert.deepEqual(JSON.parse((quotaOutput.content as { text: string }[])[0].text), quotaOutput.structuredContent);
    const quota = quotaOutput.structuredContent as { schemaVersion: number; kind: string; data: import('../src/utils/register-tool.js').QuotaResult };
    assert.equal(quota.schemaVersion, 3); assert.equal(quota.kind, 'quota'); assert.equal(quota.data.status, 'SUCCESS', JSON.stringify(quota));
    assert.equal(quota.data.groups[0].buckets[0].remaining_fraction, 0.9); assert(!('taskId' in quota.data));
    savedCode = code;
    assert.deepEqual(fs.readdirSync(workspace).sort(), ['a.txt', 'invocation.args']);
    const codeArgs = fs.readFileSync(path.join(workspace, 'invocation.args'), 'utf8').split(/\r?\n/);
    assert.equal(codeArgs[codeArgs.indexOf('--mode') + 1], 'accept-edits'); assert(codeArgs.includes('--dangerously-skip-permissions')); assert.equal(code.autoApprove, true);
    assert(progress.length); assert(progress.every((event, index) => event.total === undefined && (index === 0 || event.progress > progress[index - 1].progress)));
    const { ProgressNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const withoutToken: unknown[] = [];
    connection.client.setNotificationHandler(ProgressNotificationSchema, notification => { withoutToken.push(notification); });
    const ask = data(await connection.client.callTool({ name: 'antigravity_ask', arguments: { prompt: 'READ', workspace_dir: workspace } }));
    assert.equal(withoutToken.length, 0);
    assert.equal(ask.status, 'SUCCESS', JSON.stringify(ask)); assert.equal(ask.executionWorkspaceDir, workspace);
    const askArgs = fs.readFileSync(path.join(ask.executionWorkspaceDir!, 'invocation.args'), 'utf8').split(/\r?\n/);
    assert.equal(askArgs[askArgs.indexOf('--mode') + 1], 'accept-edits'); assert(askArgs.some(value => value.includes('Analyze only; do not modify files')));
    assert(askArgs.includes('--dangerously-skip-permissions')); assert.equal(ask.autoApprove, true);
    const plan = data(await connection.client.callTool({ name: 'antigravity_ask', arguments: {
      prompt: 'PLAN', workspace_dir: workspace, cli_mode: 'plan', auto_approve: false, effort: 'max' } }));
    assert.equal(plan.status, 'SUCCESS', JSON.stringify(plan)); assert.equal(plan.cliMode, 'plan'); assert.equal(plan.effort, 'max');
    const planArgs = fs.readFileSync(path.join(plan.executionWorkspaceDir!, 'invocation.args'), 'utf8').split(/\r?\n/);
    assert.equal(planArgs[planArgs.indexOf('--mode') + 1], 'plan'); assert(!planArgs.includes('--dangerously-skip-permissions')); assert(!planArgs.includes('--disable-slash-commands')); assert.equal(plan.autoApprove, false);
    const follow = data(await connection.client.callTool({ name: 'antigravity_ask', arguments: {
      prompt: 'READ', workspace_dir: workspace, conversation_id: code.conversationId, async_mode: true } }));
    let resumed = follow;
    await waitFor(async () => { resumed = data(await connection.client.callTool({ name: 'antigravity_status',
      arguments: { task_id: follow.taskId, after_revision: resumed.revision, wait_ms: 1000 } })); return resumed.status !== 'RUNNING'; });
    assert.equal(resumed.status, 'SUCCESS', JSON.stringify(resumed)); assert.equal(resumed.conversationId, code.conversationId);
    assert.equal(resumed.autoApprove, true);
    assert(fs.readFileSync(path.join(workspace, 'invocation.args'), 'utf8').split(/\r?\n/).includes('--dangerously-skip-permissions'));
    const hanging = fixture('native-cancel'), active = data(await connection.client.callTool({ name: 'antigravity_code',
      arguments: { prompt: 'HANG', workspace_dir: hanging, async_mode: true } }));
    await waitFor(() => fs.existsSync(path.join(hanging, 'child.pid')));
    const childPid = Number(fs.readFileSync(path.join(hanging, 'child.pid'), 'utf8'));
    const cancelled = data(await connection.client.callTool({ name: 'antigravity_cancel_task', arguments: { task_id: active.taskId } }));
    assert.equal(cancelled.status, 'CANCELLED', cancellationDiagnostic(cancelled)); assert.equal(await isProcessAlive(childPid), false);
    assert.equal(fs.readFileSync(path.join(hanging, 'a.txt'), 'utf8'), 'generated');
    const unchanged = data(await connection.client.callTool({ name: 'antigravity_cancel_task', arguments: { task_id: code.taskId } })); assert.equal(unchanged.status, 'SUCCESS');
  } finally { await connection.client.close(); }
  const shutdown = await connect(), directory = fixture('native-shutdown');
  const active = data(await shutdown.client.callTool({ name: 'antigravity_code', arguments: { prompt: 'HANG', workspace_dir: directory, async_mode: true } }));
  await waitFor(() => fs.existsSync(path.join(directory, 'child.pid')));
  const childPid = Number(fs.readFileSync(path.join(directory, 'child.pid'), 'utf8'));
  let beforeReconnect = active;
  await waitFor(async () => { beforeReconnect = data(await shutdown.client.callTool({ name: 'antigravity_status', arguments: { task_id: active.taskId } })); return !!beforeReconnect.conversationId; });
  const sessionId = beforeReconnect.conversationId!;
  await shutdown.client.close();
  assert.equal(await isProcessAlive(childPid), true);
  const fresh = await connect();
  try {
    const running = data(await fresh.client.callTool({ name: 'antigravity_status', arguments: { task_id: active.taskId } }));
    assert.equal(running.status, 'RUNNING'); assert.equal(running.conversationId, sessionId);
    const quiet = data(await fresh.client.callTool({ name: 'antigravity_status', arguments: { task_id: active.taskId, after_revision: running.revision, wait_ms: 1100, view: 'summary' } }));
    assert.equal(quiet.unchanged, true); assert.equal(quiet.revision, running.revision);
    assert.deepEqual(quiet, { summary: true, taskId: active.taskId, status: 'RUNNING', revision: running.revision, unchanged: true });
    const conflict = data(await fresh.client.callTool({ name: 'antigravity_code', arguments: { prompt: 'WRITE', workspace_dir: directory } }));
    assert.equal(conflict.errorCode, 'WORKSPACE_BUSY');
    const waiting = fresh.client.callTool({ name: 'antigravity_status', arguments: { task_id: active.taskId, after_revision: quiet.revision, wait_ms: 5000 } });
    const cancelled = data(await fresh.client.callTool({ name: 'antigravity_cancel_task', arguments: { task_id: active.taskId } }));
    assert.equal(cancelled.status, 'CANCELLED', cancellationDiagnostic(cancelled)); await waitFor(async () => !await isProcessAlive(childPid));
    assert(data(await waiting).revision > quiet.revision);
    const stored = data(await fresh.client.callTool({ name: 'antigravity_status', arguments: { task_id: savedCode!.taskId } }));
    assert.equal(stored.status, 'SUCCESS'); assert.equal(stored.response, savedCode!.response);
    const record = path.join(clientHome, '.gemini', 'antigravity-mcp-conversations-v3', crypto.createHash('sha256').update(sessionId).digest('hex') + '.json');
    assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).workspaceDir, directory);
  } finally { await fresh.client.callTool({ name: 'antigravity_cancel_task', arguments: { task_id: active.taskId } }); await fresh.client.close(); }
  const finishing = await connect(), offline = fixture('offline-result');
  const queued = data(await finishing.client.callTool({ name: 'antigravity_code', arguments: { prompt: 'DELAY', workspace_dir: offline, async_mode: true } }));
  await finishing.client.close();
  const collecting = await connect();
  try {
    let observed = queued;
    await waitFor(async () => {
      observed = data(await collecting.client.callTool({ name: 'antigravity_status', arguments: {
        task_id: queued.taskId, after_revision: observed.revision, wait_ms: 1000 } }));
      return observed.status !== 'RUNNING';
    });
    const completed = data(await collecting.client.callTool({ name: 'antigravity_status', arguments: { task_id: queued.taskId } }));
    assert.equal(completed.status, 'SUCCESS'); assert.equal(completed.response, 'Native task complete.');
    assert.equal(fs.readFileSync(path.join(offline, 'a.txt'), 'utf8'), 'generated');
  } finally { await collecting.client.callTool({ name: 'antigravity_cancel_task', arguments: { task_id: queued.taskId } }); await collecting.client.close(); }
  const expiring = await connect(), timeoutWorkspace = fixture('offline-timeout');
  const timed = data(await expiring.client.callTool({ name: 'antigravity_code', arguments: {
    prompt: 'HANG', workspace_dir: timeoutWorkspace, async_mode: true, execution_timeout_minutes: 0.04 } }));
  await waitFor(() => fs.existsSync(path.join(timeoutWorkspace, 'child.pid')));
  const timedChild = Number(fs.readFileSync(path.join(timeoutWorkspace, 'child.pid'), 'utf8'));
  await expiring.client.close();
  const resumed = await connect();
  try {
    let outcome = timed;
    await waitFor(async () => { outcome = data(await resumed.client.callTool({ name: 'antigravity_status', arguments: { task_id: timed.taskId, after_revision: outcome.revision, wait_ms: 1000 } })); return outcome.status !== 'RUNNING'; });
    assert.equal(outcome.status, 'TIMEOUT'); assert.equal(outcome.deadlineAt, timed.deadlineAt); assert.equal(await isProcessAlive(timedChild), false);
  } finally { await resumed.client.close(); }
});

test('observer failures cannot cancel a successful task', async () => {
  let called = 0;
  const result = await run(fixture('observer-failure'), { delay: 200 }, { onProgress: async () => { called++; throw new Error('observer failed'); } });
  assert(called); assert.equal(result.status, 'SUCCESS');
});
test('lease cleanup failure stays pending and cancellation retries release without reverting files', async () => {
  const workspace = fixture('lease-cleanup'), mutableFs = fs as unknown as { unlinkSync: typeof fs.unlinkSync }, original = fs.unlinkSync;
  mutableFs.unlinkSync = file => {
    if (String(file).includes('antigravity-mcp-leases') && String(file).endsWith('.json')) throw new Error('LEASE_RELEASE_FAILED: injected refusal');
    original(file);
  };
  let result: Awaited<ReturnType<typeof run>>;
  try { result = await workerFault('unlinkSync', 'antigravity-mcp-leases', () => run(workspace, { writes: { 'a.txt': 'kept' } })); }
  finally { mutableFs.unlinkSync = original; }
  assert.equal(result.status, 'RUNNING'); assert.equal(result.errorCode, 'LEASE_RELEASE_FAILED'); assert.equal(result.currentPhase, 'STOPPING');
  assert.equal(acquireWorkspaceLease('cleanup-contender', workspace), false);
  assert.equal((await taskTracker.cancel(result.taskId!))?.result.status, 'CANCELLED');
  assert.equal(acquireWorkspaceLease('cleanup-contender', workspace), true); releaseWorkspaceLease('cleanup-contender');
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'kept');
});
test('a missing explicit CLI fails before preparation instead of falling back or blaming its output', async () => {
  const previous = process.env.AGY_PATH, count = startCount(); process.env.AGY_PATH = path.join(suite, 'missing-agy.exe');
  try {
    const result = await executeAgy({ prompt: 'test', workspaceDir: fixture('missing-cli'), analysis: true });
    assert.equal(result.errorCode, 'AGY_NOT_FOUND'); assert.equal(result.executionStarted, false); assert.equal(result.taskId, null); assert.equal(startCount(), count);
  } finally { if (previous === undefined) delete process.env.AGY_PATH; else process.env.AGY_PATH = previous; }
});
test('polling exposes current model text and repeated final cursors omit response and progress bodies', async () => {
  const workspace = fixture('compact-polling'), response = 'long report '.repeat(1000);
  const steps = [{ step_index: 2, step_type: 'agent_response', state: 'ACTIVE', text_delta: '正在分析中文文件。' }];
  const started = await run(workspace, { response, steps, delay: 400 }, { asyncMode: true });
  assert.equal(started.status, 'RUNNING');
  await waitFor(() => taskTracker.get(started.taskId!)?.result.latestText === '正在分析中文文件。');
  const task = taskTracker.get(started.taskId!)!; assert.equal(taskTracker.report(task).response, '');
  assert.equal(taskTracker.report(task).latestText, '正在分析中文文件。');
  assert.equal((await final(started.taskId!)).response, response);
  const brief = taskTracker.report(task, true); assert.equal(brief.response, ''); assert.equal(brief.latestText, ''); assert.deepEqual(brief.recentTools, []);
  assert.equal(taskTracker.report(task).response, response);
});

test('removed HTTP/SSE arguments fail clearly rather than starting a listener', async () => {
  const output = await runManagedProcess(process.execPath, [path.resolve('dist/index.js'), '--transport', 'sse']);
  assert.equal(output.exitCode, 1); assert.match(output.stderr, /stdio only/);
});
test('a silent process completes after sixty seconds without automatic cancellation', { timeout: 90000 }, async () => {
  const started = await run(fixture('silent'), { silent: true, delay: 61000 }, { asyncMode: true });
  await waitFor(() => !!taskTracker.get(started.taskId!)?.result.executionStarted);
  const task = taskTracker.get(started.taskId!)!, revision = task.result.revision;
  await new Promise(resolve => setTimeout(resolve, 31000));
  const observed = taskTracker.report(task);
  assert(observed.elapsedSeconds !== null && observed.elapsedSeconds >= 29); assert.equal(observed.revision, revision); assert.equal(observed.lastOutputAt, null);
  assert.equal(task.result.revision, revision);
  const result = await final(started.taskId!, 45000);
  assert.equal(result.status, 'SUCCESS'); assert(result.elapsedSeconds !== null && result.elapsedSeconds >= 60); assert(!('elapsedIsEstimate' in result)); assert(!('health' in result));
});
