import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testTempRoot } from './helpers/temp-root.js';

const root = fs.mkdtempSync(path.join(testTempRoot(), 'agy-content-filter-'));
const keys = ['ANTIGRAVITY_MCP_STATE_HOME', 'TEST_MODEL_STARTS', 'GIT_CEILING_DIRECTORIES'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.ANTIGRAVITY_MCP_STATE_HOME = path.join(root, 'state');
process.env.TEST_MODEL_STARTS = path.join(root, 'starts');
process.env.GIT_CEILING_DIRECTORIES = root;
const { executeAgy } = await import('../src/agy-executor.js');
const { taskTracker, TaskTracker } = await import('../src/utils/task-tracker.js');
const { payloadResult, payloadStatus, normalizeResult, ResultSchema } = await import('../src/utils/register-tool.js');
const { acquireWorkspaceLease, releaseWorkspaceLease } = await import('../src/utils/workspace-lease.js');
const { sessionManager } = await import('../src/utils/session-manager.js');
const cli = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));

// 来自实际拒绝响应的完整通知；正常报告可能引用它，不能只匹配关键词。
const notice = "This request was blocked by Gemini's filters. They can occasionally trigger by mistake on safe coding, security, or biology-related queries. "
  + 'Please try rephrasing your prompt. You can [send feedback](https://ai.google.dev/gemini-api/docs/troubleshooting#file-bug) '
  + 'or read more about [our policies here](https://policies.google.com/terms/generative-ai/use-policy).';
const starts = () => fs.readFileSync(process.env.TEST_MODEL_STARTS!, 'utf8').trim().split('\n').length;
function workspace(name: string): string { const directory = path.join(root, name); fs.mkdirSync(directory); return directory; }
const run = (workspaceDir: string, response: string, analysis = true, input: Record<string, unknown> = {}) => executeAgy({
  prompt: 'FIXTURE:' + JSON.stringify({ response, ...input }), workspaceDir, analysis,
  cliPath: process.execPath, cliArgsPrefix: [cli], requestWaitTimeoutMs: 20000
});
test.after(async () => {
  await taskTracker.shutdownAll();
  const resolved = fs.realpathSync.native(root);
  assert.equal(path.dirname(resolved), testTempRoot()); assert(path.basename(resolved).startsWith('agy-content-filter-'));
  assert(!fs.lstatSync(root).isSymbolicLink()); fs.rmSync(resolved, { recursive: true, force: true });
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
});

test('a successful CLI containing only the known Gemini refusal fails analysis without losing upstream evidence', async () => {
  const directory = workspace('analysis'), response = notice + '\n';
  const result = await run(directory, response, true, {
    steps: [{ step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: response }]
  });
  assert.equal(result.status, 'ERROR', 'a filter refusal is not a completed review');
  assert.equal(result.executionStatus, 'CLI_CONTENT_FILTERED'); assert.equal(result.errorCode, 'CLI_CONTENT_FILTERED');
  assert.equal(result.failureStage, 'RESULT'); assert.equal(result.schemaVersion, 3);
  assert.equal(result.cliStatus, 'SUCCESS'); assert.equal(result.processExitCode, 0); assert.equal(result.cliError, null);
  assert.equal(result.stderrTail, ''); assert.equal(result.response, response); assert.equal(result.latestText, response);
  assert.match(result.errorMessage!, /Gemini.*过滤/); assert.match(result.nextAction!, /用户/);
  assert.match(result.nextAction!, /不自动重试/); assert.match(result.nextAction!, /换模型/);
  assert.equal(starts(), 1, 'a refusal must not start another model call');
  ResultSchema.parse(result);
  const observer = new TaskTracker(), stored = observer.report(observer.get(result.taskId!)!);
  assert.equal(stored.status, 'ERROR'); assert.equal(stored.errorCode, result.errorCode); assert.equal(stored.response, response);
  for (const wrapped of [payloadResult(result), payloadStatus('task', stored)]) {
    assert.equal(wrapped.isError, true);
    const content = wrapped.content[0]; assert.equal(content.type, 'text');
    assert.deepEqual(JSON.parse(content.text), wrapped.structuredContent);
  }
  assert.equal(acquireWorkspaceLease('after-content-filter', directory), true); releaseWorkspaceLease('after-content-filter');
});

test('the same Gemini refusal fails code tasks while preserving whitespace, partial files and the session', async () => {
  const directory = workspace('code'), response = '\r\n  ' + notice.replace(/ /g, '\r\n') + '\t\n';
  const before = starts();
  const result = await run(directory, response, false, { writes: { 'partial.txt': 'keep this edit' } });
  assert.equal(result.status, 'ERROR'); assert.equal(result.errorCode, 'CLI_CONTENT_FILTERED');
  assert.equal(result.failureStage, 'RESULT'); assert.equal(result.response, response);
  assert.equal(result.cliStatus, 'SUCCESS'); assert.equal(result.processExitCode, 0);
  assert.equal(fs.readFileSync(path.join(directory, 'partial.txt'), 'utf8'), 'keep this edit');
  assert(result.conversationId); assert.equal(sessionManager.resolve(result.conversationId, directory).taskId, result.taskId);
  assert.equal(starts(), before + 1, 'no automatic retry or conversation continuation');
});

test('reports that quote or discuss a filter notice remain successful', async () => {
  const responses = [
    '审核结果：上游曾返回以下拒绝通知：\n' + notice,
    notice + '\n\n审核结果：该字符串是页面文案，应修正错误处理。',
    '> ' + notice,
    '```text\n' + notice + '\n```',
    "The reviewed code contains the sentence: This request was blocked by Gemini's filters."
  ];
  for (const [index, response] of responses.entries()) {
    const result = await run(workspace('quote-' + index), response);
    assert.equal(result.status, 'SUCCESS', 'quoted or discussed notices are report content');
    assert.equal(result.errorCode, null); assert.equal(result.response, response); assert.equal(payloadResult(result).isError, false);
  }
});

test('content filtering does not override an explicit CLI error or a nonzero exit', async () => {
  const explicit = await run(workspace('explicit-error'), notice, true, { successError: 'upstream failed' });
  assert.equal(explicit.errorCode, 'CLI_ERROR'); assert.equal(explicit.cliError, 'upstream failed');
  assert.equal(explicit.failureStage, 'CLI'); assert.equal(explicit.response, notice);
  const exit = await run(workspace('nonzero-exit'), notice, true, { exitCode: 7 });
  assert.equal(exit.errorCode, 'CLI_EXIT_FAILED'); assert.equal(exit.failureStage, 'CLI'); assert.equal(exit.processExitCode, 7);
});

test('the new error code receives result-stage guidance through the existing schema', () => {
  const result = normalizeResult({ status: 'ERROR', executionStatus: 'CLI_CONTENT_FILTERED', errorCode: 'CLI_CONTENT_FILTERED',
    currentPhase: 'IDLE', executionStarted: true, cliStatus: 'SUCCESS', processExitCode: 0, response: notice });
  assert.equal(result.failureStage, 'RESULT'); assert.match(result.nextAction!, /Gemini.*过滤/);
  assert.match(result.nextAction!, /不自动重试/); assert.equal(payloadResult(result).isError, true);
  assert.equal(result.schemaVersion, 3);
});
