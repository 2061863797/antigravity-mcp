import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testTempRoot } from './helpers/temp-root.js';

// 覆盖：终态等待、退出码翻译、中断后部分结论、只读守卫、进度摘要、终态去重和工具说明。
const suite = fs.mkdtempSync(path.join(testTempRoot(), 'antigravity-usability-'));
const home = path.join(suite, 'home'); fs.mkdirSync(home);
(os as unknown as { homedir: () => string }).homedir = () => home;
const { executeAgy } = await import('../src/agy-executor.js');
const { taskTracker } = await import('../src/utils/task-tracker.js');
const { describeExitCode, exitFailureMessage } = await import('../src/utils/exit-codes.js');
const { evaluateToolCall, ensureReadonlyGuard, READONLY_ENV, READONLY_PLUGIN } = await import('../src/utils/readonly-guard.js');
const { summarizeTask, normalizeResult } = await import('../src/utils/register-tool.js');
const { createAntigravityServer } = await import('../src/server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
type Options = import('../src/agy-executor.js').AgyExecuteOptions;
type Result = import('../src/utils/register-tool.js').TaskResult;
type Summary = import('../src/utils/register-tool.js').TaskSummary;
const cli = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
const fixture = (name: string) => { const directory = path.join(suite, name + '-' + crypto.randomUUID().slice(0, 8)); fs.mkdirSync(directory, { recursive: true }); return directory; };
const run = (workspaceDir: string, input: Record<string, unknown> = {}, options: Partial<Options> = {}) =>
  executeAgy({ prompt: 'FIXTURE:' + JSON.stringify(input), workspaceDir, cliPath: process.execPath, cliArgsPrefix: [cli], requestWaitTimeoutMs: 20000, ...options });
const text = (index: number, delta: string) => ({ step_index: index, step_type: 'agent_response', state: 'ACTIVE', text_delta: delta });
const view = (index: number, file: string) => ({ step_index: index, step_type: 'tool', tool_name: 'view_file', state: 'DONE', tool_info: { parameters: { AbsolutePath: file } } });
async function connect() {
  const server = createAntigravityServer(), client = new Client({ name: 'usability', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const output = await client.callTool({ name, arguments: args });
    const payload = output.structuredContent as { data?: Result | Summary } & Result;
    return name === 'antigravity_status' ? payload.data! : payload;
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}
after(async () => {
  await taskTracker.shutdownAll();
  fs.rmSync(suite, { recursive: true, force: true });
});

test('exit codes are translated into plain language with the raw value kept', () => {
  assert.match(describeExitCode(1073807364, 'win32')!, /外部强制结束/);
  assert.match(describeExitCode(3221225786, 'win32')!, /Ctrl\+C/);
  assert.match(describeExitCode(-1073741510, 'win32')!, /Ctrl\+C/);
  assert.equal(describeExitCode(0, 'win32'), undefined);
  assert.equal(describeExitCode(12345, 'win32'), undefined);
  if (process.platform !== 'win32') assert.match(describeExitCode(137, 'linux')!, /SIGKILL/);
  const message = exitFailureMessage(1073807364, 'tail text');
  assert.match(message, /0x40010004/); assert.match(message, /1073807364/); assert.match(message, /tail text/);
});

test('read-only guard allows reads and read-only commands and denies writes and side effects', () => {
  for (const name of ['view_file', 'grep_search', 'list_dir', 'find_by_name']) assert.equal(evaluateToolCall(name, {}), null);
  for (const name of ['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'delete_file', 'call_mcp_tool', 'browser_subagent', 'mystery']) {
    assert.match(evaluateToolCall(name, {})!, /read_only mode/);
  }
  const command = (line: string) => evaluateToolCall('run_command', { CommandLine: line });
  for (const line of ['git status', 'git --no-pager log -5 --oneline', 'git -C sub diff HEAD~1', 'rg -n "TODO" src', 'Get-Content a.txt | Select-String foo',
    'Get-ChildItem -Recurse -Filter *.ts', 'cat a.txt | head -n 5', 'find . -name "*.md"', 'type README.md']) assert.equal(command(line), null, line);
  for (const line of ['echo hi > a.txt', 'git commit -m x', 'git -c core.pager=evil log', 'git diff --output=x.patch', 'npm test', 'Remove-Item a.txt',
    'Get-Content a | Set-Content b', 'Get-ChildItem; Remove-Item x', 'cmd /c del a', 'node -e "1"', 'find . -delete', 'rg --pre evil foo', 'sort a -o b',
    'Get-ChildItem | ForEach-Object { Remove-Item $_ }', 'Invoke-WebRequest x -OutFile y', 'git status && rm -rf x', '']) assert.match(command(line) ?? '', /read_only mode/, line);
});

test('installed guard is neutral when inactive and denies writes when active', { skip: process.platform !== 'win32' && 'Windows 包装脚本' }, () => {
  const dir = ensureReadonlyGuard();
  assert.equal(dir, path.join(home, '.gemini', 'config', 'plugins', READONLY_PLUGIN));
  const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
  const command: string = hooks[READONLY_PLUGIN].PreToolUse[0].hooks[0].command;
  assert(!/["\s]/.test(command), 'agy 会转义坏引号，钩子命令不能带引号或空格：' + command);
  const before = fs.readFileSync(path.join(dir, 'guard.mjs'), 'utf8'); ensureReadonlyGuard();
  assert.equal(fs.readFileSync(path.join(dir, 'guard.mjs'), 'utf8'), before);
  const invoke = (call: unknown, env: Record<string, string | undefined>) => spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', command], {
    input: JSON.stringify({ toolCall: call }), encoding: 'utf8', windowsHide: true, env: { ...process.env, [READONLY_ENV]: undefined, ...env } });
  const write = { name: 'write_to_file', args: { TargetFile: 'x', CodeContent: 'y' } };
  // 实测：钩子没有任何输出才是中性放行，输出 {} 会被 agy 当作拒绝。
  const inactive = invoke(write, {}); assert.equal(inactive.status, 0); assert.equal(inactive.stdout, '');
  const log = path.join(suite, 'guard-' + crypto.randomUUID() + '.log');
  const denied = invoke(write, { [READONLY_ENV]: log }); assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).decision, 'deny');
  const allowed = invoke({ name: 'view_file', args: { AbsolutePath: 'a' } }, { [READONLY_ENV]: log });
  assert.equal(allowed.status, 0); assert.equal(allowed.stdout, '');
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    [{ tool: 'write_to_file', denied: true }, { tool: 'view_file', denied: false }]);
  const broken = invoke(null, { [READONLY_ENV]: log }); assert.equal(JSON.parse(broken.stdout).decision, 'deny');
});

test('read_only is ask-only, sets the guard environment, and fails when a write succeeds or the guard never ran', async () => {
  const code = await run(fixture('readonly-code'), {}, { readOnly: true });
  assert.equal(code.errorCode, 'INVALID_ARGUMENT'); assert.equal(code.executionStarted, false);
  const workspace = fixture('readonly-env'), capture = path.join(workspace, '..', 'capture-' + crypto.randomUUID() + '.json');
  // 假 agy 不调用钩子：有工具调用却没有守卫记录，必须判为守卫未生效，而不是成功。
  const silent = await run(workspace, { capture }, { analysis: true, readOnly: true });
  assert.equal(silent.errorCode, 'READONLY_GUARD_UNAVAILABLE'); assert.equal(silent.readOnly, true);
  assert.match(JSON.parse(fs.readFileSync(capture, 'utf8')).args.join(' '), /Read-only mode is enforced/);
  assert(fs.existsSync(path.join(home, '.gemini', 'config', 'plugins', READONLY_PLUGIN, 'hooks.json')));
  const violated = await run(fixture('readonly-violation'), { steps: [{ step_index: 2, step_type: 'tool', tool_name: 'write_to_file', state: 'DONE',
    tool_info: { parameters: { TargetFile: 'x' } } }] }, { analysis: true, readOnly: true });
  assert.equal(violated.errorCode, 'READONLY_VIOLATION'); assert.match(violated.errorMessage!, /write_to_file/);
  const normal = await run(fixture('readonly-off'), {}, { analysis: true });
  assert.equal(normal.status, 'SUCCESS'); assert.equal(normal.readOnly, false);
});

test('wait_for terminal returns once per wait window instead of on every tool call', async () => {
  const workspace = fixture('terminal-wait'), files = Array.from({ length: 30 }, (_, index) => view(index + 2, path.join(workspace, `f${index}.ts`)));
  // 用假 CLI 提交，只通过 MCP 查询状态，避免调用真实 agy。
  const begin = Date.now(), waitMs = 1000;
  const started = await run(workspace, { steps: files, stepDelay: 50, response: '完整报告' }, { asyncMode: true, analysis: true });
  const connection = await connect();
  try {
    const id = started.taskId!;
    // 进程启动开销不计入假 agy 的步骤时长，按实际总时长计算允许的返回次数。
    let calls = 0, result: Result | Summary;
    do { result = await connection.call('antigravity_status', { task_id: id, wait_for: 'terminal', wait_ms: waitMs, view: 'summary' }); calls++; }
    while (result.status === 'RUNNING' && calls < 60);
    const allowed = Math.ceil((Date.now() - begin) / waitMs);
    assert(calls <= allowed, `calls ${calls} > ${allowed}`);
    assert(!('summary' in result)); assert.equal(result.status, 'SUCCESS'); assert.equal(result.response, '完整报告');
    assert.equal(result.latestText, '', '终态完整文本只返回一份');
    assert.equal(result.progress.filesRead, 31); assert(result.progressRevision >= 4);
  } finally { await connection.close(); }
});

test('progress summary reports cumulative counters and progress waits only wake on significant change', async () => {
  const workspace = fixture('progress-wait'), steps = Array.from({ length: 25 }, (_, index) => view(index + 2, path.join(workspace, `p${index}.ts`)));
  const started = await run(workspace, { steps, stepDelay: 40 }, { asyncMode: true, analysis: true }), id = started.taskId!;
  const connection = await connect();
  try {
    let wakes = 0, last: Result | Summary | undefined;
    while (taskTracker.get(id)!.result.status === 'RUNNING' && wakes < 30) {
      last = await connection.call('antigravity_status', { task_id: id, wait_for: 'progress', wait_ms: 5000, view: 'summary' }); wakes++;
    }
    // 26 个文件跨过两个 10 文件阈值，加上阶段变化和终态，远少于逐事件唤醒的次数。
    assert(wakes <= 8, 'wakes ' + wakes); assert(last);
    const summary = summarizeTask(normalizeResult({ ...taskTracker.report(taskTracker.get(id)!), status: 'RUNNING', executionStatus: 'RUNNING' }));
    assert('summary' in summary); assert.equal(summary.progress?.filesRead, 26); assert.equal(typeof summary.progress?.elapsedSeconds, 'number');
  } finally { await connection.close(); }
});

test('an externally terminated agy keeps partial conclusions and explains how to resume', async () => {
  const workspace = fixture('killed');
  const result = await run(workspace, { steps: [view(2, path.join(workspace, 'a.ts')), text(3, '发现一：入口缺少校验。'), text(3, '发现二：'), text(4, '日志重复。')],
    omitResult: true, exitCode: 1073807364 }, { analysis: true });
  assert.equal(result.status, 'ERROR'); assert.equal(result.errorCode, 'CLI_EXIT_FAILED');
  assert.match(result.exitReason!, /外部强制结束/); assert.match(result.errorMessage!, /0x40010004/);
  assert.match(result.partialResponse!, /发现一：入口缺少校验。发现二：/); assert.match(result.partialResponse!, /日志重复/);
  assert.match(result.partialResponse!, /已读文件/);
  assert(result.partialOutputPath && fs.existsSync(result.partialOutputPath));
  assert.equal(result.latestText, '', '部分结论已在 partialResponse 中，不重复返回');
  assert(result.conversationId); assert.match(result.resumeExample!, new RegExp(result.conversationId!));
  const example = JSON.parse(result.resumeExample!.slice(result.resumeExample!.indexOf('{')));
  assert.equal(example.workspace_dir, result.workspaceDir); assert.equal(example.conversation_id, result.conversationId);
  assert.match(result.nextAction!, /resumeExample/);
  const resumed = await run(workspace, { response: '完整报告' }, { analysis: true, conversationId: result.conversationId! });
  assert.equal(resumed.status, 'SUCCESS'); assert.equal(resumed.conversationId, result.conversationId);
  assert.equal(resumed.partialResponse, null); assert.equal(resumed.resumeExample, null);
});

test('successful tasks return the full text once and leave no partial file', async () => {
  const workspace = fixture('dedupe');
  const result = await run(workspace, { steps: [text(2, '正文')], response: '正文' }, { analysis: true });
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.response, '正文'); assert.equal(result.latestText, '');
  assert.equal(result.partialResponse, null); assert.equal(result.exitReason, null);
  const stored = taskTracker.get(result.taskId!)!; assert.equal(stored.result.latestText, '正文', '记录本身保留，只在返回时去重');
  assert(!fs.existsSync(path.join(home, '.gemini', 'antigravity-mcp-jobs-v1', result.taskId + '.partial.md')));
});

test('completion wake finds the task in any tool_response shape', async () => {
  const { extractTask } = await import('../src/hook-wait.js');
  const result = { schemaVersion: 3, taskId: 'task_1_abcd1234', status: 'RUNNING', response: '' };
  for (const shape of [result, { structuredContent: result }, { content: [{ type: 'text', text: JSON.stringify(result) }] },
    [{ type: 'text', text: JSON.stringify(result) }], JSON.stringify(result), { result: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }] }) }]) {
    assert.deepEqual(extractTask(shape), { taskId: 'task_1_abcd1234', status: 'RUNNING' }, JSON.stringify(shape));
  }
  assert.equal(extractTask({ taskId: '../../etc', status: 'RUNNING' }), undefined);
  assert.equal(extractTask('not json'), undefined);
});

test('completion wake wakes once for an uncollected finish, stays silent when the result was returned, and reports timeouts', async () => {
  const { decideWake } = await import('../src/hook-wait.js');
  const fast = { pollMs: 20, graceMs: 200 };
  const payload = (result: Result) => ({ tool_name: 'mcp__plugin_antigravity-mcp_antigravity__antigravity_ask', tool_response: { structuredContent: result } });
  // 同步调用已直接返回终态：不唤醒。
  const sync = await run(fixture('wake-sync'), {}, { analysis: true });
  assert.deepEqual(await decideWake(payload(sync), fast), { exitCode: 0 });
  // 异步任务结束后没人取结果：唤醒一次，提示里有 taskId 和状态，并标明子 agent。
  const started = await run(fixture('wake-async'), { delay: 300 }, { asyncMode: true, analysis: true });
  const woke = await decideWake({ ...payload(started), agent_type: 'general-purpose' }, fast);
  assert.equal(woke.exitCode, 2); assert.match(woke.message!, new RegExp(started.taskId!)); assert.match(woke.message!, /SUCCESS/);
  assert.match(woke.message!, /general-purpose/); assert.match(woke.message!, /antigravity_status/);
  // 结果已由 antigravity_status 返回：不再唤醒。
  const collected = await run(fixture('wake-collected'), { delay: 300 }, { asyncMode: true, analysis: true });
  const connection = await connect();
  try {
    const waiting = decideWake(payload(collected), fast);
    const final = await connection.call('antigravity_status', { task_id: collected.taskId!, wait_for: 'terminal', wait_ms: 15000 });
    assert.equal(final.status, 'SUCCESS'); assert.deepEqual(await waiting, { exitCode: 0 });
  } finally { await connection.close(); }
  // 等待超时仍唤醒，说明任务还在运行。
  const hanging = await run(fixture('wake-timeout'), { hang: true }, { asyncMode: true, analysis: true });
  try {
    const timeout = await decideWake(payload(hanging), { ...fast, timeoutMs: 300 });
    assert.equal(timeout.exitCode, 2); assert.match(timeout.message!, /仍在运行/);
  } finally { await taskTracker.cancel(hanging.taskId!); }
});

test('completion wake entry point exits 2 with the message on stderr and 0 on bad input', async () => {
  const entry = fileURLToPath(new URL('../src/hook-wait.ts', import.meta.url));
  const finished = await run(fixture('wake-entry'), { delay: 100 }, { asyncMode: true, analysis: true });
  const invoke = (input: string) => spawnSync(process.execPath, ['--import', 'tsx', entry, '--timeout', '1'], { input, encoding: 'utf8', windowsHide: true,
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, ANTIGRAVITY_MCP_STATE_HOME: home } });
  const woke = invoke(JSON.stringify({ tool_response: { content: [{ type: 'text', text: JSON.stringify(finished) }] } }));
  assert.equal(woke.status, 2, woke.stderr); assert.match(woke.stderr, new RegExp(finished.taskId!)); assert.equal(woke.stdout, '');
  for (const bad of ['', 'not json', JSON.stringify({ tool_response: { taskId: 'task_9_missing00', status: 'RUNNING' } })]) {
    const quiet = invoke(bad); assert.equal(quiet.status, 0, bad + quiet.stderr); assert.equal(quiet.stderr, '');
  }
});

test('the Claude Code manifest declares the asyncRewake hook and Codex manifests do not', () => {
  const read = (file: string) => JSON.parse(fs.readFileSync(fileURLToPath(new URL('../plugin/' + file, import.meta.url)), 'utf8'));
  const hook = read('claude-plugin.json').hooks.PostToolUse[0];
  assert(new RegExp('^(?:' + hook.matcher + ')$').test('mcp__plugin_antigravity-mcp_antigravity__antigravity_ask'));
  assert(new RegExp('^(?:' + hook.matcher + ')$').test('mcp__antigravity-mcp__antigravity_code'));
  assert(!new RegExp('^(?:' + hook.matcher + ')$').test('mcp__plugin_antigravity-mcp_antigravity__antigravity_status'));
  const handler = hook.hooks[0];
  assert.equal(handler.asyncRewake, true); assert.equal(handler.command, 'node');
  assert.deepEqual(handler.args, ['${CLAUDE_PLUGIN_ROOT}/runtime/dist/hook-wait.js', '--timeout', '60']);
  assert(handler.timeout > 3600, 'Claude Code 的钩子超时必须长于内部 60 分钟等待，否则唤醒会丢');
  assert(!('hooks' in read('plugin.json')) && !('hooks' in read('mcp.json')));
});

test('tool descriptions tell an agent without context to wait synchronously with a timeout', async () => {
  const server = createAntigravityServer(), client = new Client({ name: 'descriptions', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  try {
    const tools = Object.fromEntries((await client.listTools()).tools.map(tool => [tool.name, tool]));
    for (const name of ['antigravity_ask', 'antigravity_code']) {
      const tool = tools[name], properties = tool.inputSchema.properties as Record<string, { description?: string }>;
      assert.match(tool.description!, /不会通知/); assert.match(tool.description!, /同步模式并设 timeout_minutes/); assert.match(tool.description!, /wait_for:"terminal"/);
      assert.match(properties.async_mode.description!, /没有任何通知/); assert.match(properties.async_mode.description!, /同步模式并设置 timeout_minutes/);
      assert.match(properties.timeout_minutes.description!, /tool_timeout_sec/);
    }
    assert.match((tools.antigravity_ask.inputSchema.properties as Record<string, { description?: string }>).read_only.description!, /推荐传 true/);
    assert(!('read_only' in (tools.antigravity_code.inputSchema.properties as object)));
    assert.match(tools.antigravity_status.description!, /wait_for:"terminal"/);
    const skill = fs.readFileSync(fileURLToPath(new URL('../plugin/skills/antigravity-delegation/SKILL.md', import.meta.url)), 'utf8');
    assert.match(skill, /不会通知/); assert.match(skill, /timeout_minutes/); assert.match(skill, /wait_for: "terminal"/); assert.match(skill, /read_only: true/);
  } finally { await client.close(); await server.close(); }
});
