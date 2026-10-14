import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 可用性验收：终态等待、外部结束后的部分结论与续接、只读拦截。会调用真实模型，须用户授权后手动运行。
// 用法：npm run build 后 ANTIGRAVITY_LIVE_TESTS=1 node scripts/live-usability.mjs [all|wait|kill|readonly]
if (process.env.ANTIGRAVITY_LIVE_TESTS !== '1') throw new Error('Real model acceptance requires authorization and ANTIGRAVITY_LIVE_TESTS=1.');
if (process.platform !== 'win32') throw new Error('外部结束用例使用 Windows TerminateProcess 模拟 0x40010004。');
const only = process.argv[2] ?? 'all';
const root = fileURLToPath(new URL('../', import.meta.url)), base = path.join(root, 'audit', 'live-usability');
fs.mkdirSync(base, { recursive: true });
const directory = fs.mkdtempSync(path.join(base, 'run-'));
const stateHome = os.homedir();
const cli = process.env.AGY_PATH ?? path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
const report = { directory, cases: {} };
const save = () => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
// 审核目标：本仓库 src 的副本，避免只读失效时改到真实源码。
function reviewWorkspace(name) {
  const workspace = path.join(directory, name); fs.cpSync(path.join(root, 'src'), path.join(workspace, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: workspace }); execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.email=live@example.invalid', '-c', 'user.name=live', 'commit', '-qm', 'base'], { cwd: workspace });
  return workspace;
}
const reviewPrompt = '审核 src 目录中任务状态跟踪与结果格式相关的代码（src/utils/task-tracker.ts、src/utils/register-tool.ts、src/tools/system-tools.ts，以及它们直接调用的文件）。'
  + '逐个阅读这些文件后，列出最多 8 个具体问题，每个给出文件、行号、触发条件和影响。只输出审核报告。';
const client = new Client({ name: 'usability-live', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/index.js')], env: { ...process.env, AGY_PATH: cli }, stderr: 'pipe' });
const call = async (name, args) => {
  const output = await client.callTool({ name, arguments: args }, undefined, { timeout: 30 * 60000 });
  const payload = output.structuredContent; return payload.kind === 'task' ? payload.data : payload;
};
await client.connect(transport);

async function waitCase() {
  const workspace = reviewWorkspace('wait'), started = await call('antigravity_ask', { prompt: reviewPrompt, workspace_dir: workspace, read_only: true, async_mode: true });
  const begin = Date.now(), waitMs = 60000, replies = [];
  let result;
  do {
    result = await call('antigravity_status', { task_id: started.taskId, wait_for: 'terminal', wait_ms: waitMs, view: 'summary' });
    replies.push({ at: Date.now() - begin, status: result.status, progress: result.progress ?? null });
  } while (result.status === 'RUNNING' && !result.errorCode);
  const duration = Date.now() - begin, allowed = Math.ceil(duration / waitMs);
  report.cases.wait = { taskId: started.taskId, duration, calls: replies.length, allowed, replies, status: result.status,
    responseChars: result.response?.length ?? 0, latestTextChars: result.latestText?.length ?? 0, progress: result.progress };
  save();
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result).slice(0, 2000));
  assert(replies.length <= allowed, `返回 ${replies.length} 次，超过 ceil(${duration}/${waitMs}) = ${allowed}`);
  assert(result.response.length > 200); assert.equal(result.latestText, '');
}

// 用 TerminateProcess(0x40010004) 结束 agy，复现“被外部强制结束”。
function terminateAgy(taskId) {
  const record = JSON.parse(fs.readFileSync(path.join(stateHome, '.gemini', 'antigravity-mcp-jobs-v1', taskId + '.task.json'), 'utf8'));
  const script = `$ids=@(${record.childPids.join(',')}); $all=Get-CimInstance Win32_Process; $queue=[System.Collections.Generic.Queue[int]]::new(); $ids|%{$queue.Enqueue($_)};
$found=@(); while($queue.Count){ $p=$queue.Dequeue(); $all|?{$_.ParentProcessId -eq $p}|%{ if($_.Name -eq 'agy.exe'){ $found+=$_.ProcessId } ; $queue.Enqueue([int]$_.ProcessId) } }
Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr OpenProcess(uint a, bool b, int c); [DllImport("kernel32.dll")] public static extern bool TerminateProcess(System.IntPtr h, uint c);'
foreach($id in $found){ $h=[W.K]::OpenProcess(1,$false,$id); [void][W.K]::TerminateProcess($h, 0x40010004) }; $found -join ','`;
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
}
async function killCase() {
  const workspace = reviewWorkspace('kill');
  const prompt = reviewPrompt + ' 每读完一个文件，先用一两句话写出该文件的初步发现，再读下一个文件。';
  const started = await call('antigravity_ask', { prompt, workspace_dir: workspace, read_only: true, async_mode: true });
  let progress;
  for (let attempt = 0; attempt < 20; attempt++) {
    progress = await call('antigravity_status', { task_id: started.taskId, wait_for: 'progress', wait_ms: 30000, view: 'summary' });
    if (progress.status !== 'RUNNING' || (progress.progress?.filesRead ?? 0) >= 3) break;
  }
  assert.equal(progress.status, 'RUNNING', '任务在结束 agy 前已完成，无法验证中断');
  const killed = terminateAgy(started.taskId);
  const failed = await call('antigravity_status', { task_id: started.taskId, wait_for: 'terminal', wait_ms: 60000 });
  report.cases.kill = { taskId: started.taskId, killedPids: killed, beforeKill: progress, status: failed.status, errorCode: failed.errorCode,
    exitReason: failed.exitReason, errorMessage: failed.errorMessage, partialResponse: failed.partialResponse, partialOutputPath: failed.partialOutputPath,
    resumeExample: failed.resumeExample, nextAction: failed.nextAction };
  save();
  assert(killed, '没有找到 agy 进程'); assert.equal(failed.status, 'ERROR'); assert.match(failed.exitReason ?? '', /外部强制结束/);
  assert(failed.partialResponse, '没有保存部分结论'); assert(failed.resumeExample?.includes(failed.conversationId));
  const example = JSON.parse(failed.resumeExample.slice(failed.resumeExample.indexOf('{')));
  const resumed = await call('antigravity_ask', { ...example, timeout_minutes: 25 });
  report.cases.kill.resumed = { status: resumed.status, responseChars: resumed.response?.length ?? 0, conversationId: resumed.conversationId,
    response: resumed.response?.slice(0, 4000) };
  save();
  assert.equal(resumed.status, 'SUCCESS'); assert.equal(resumed.conversationId, failed.conversationId); assert(resumed.response.length > 200);
}

async function readonlyCase() {
  const workspace = path.join(directory, 'readonly'); fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'a.txt'), 'original\n');
  const prompt = '这是只读模式验证。依次尝试：1) 用文件写入工具创建 probe.txt，内容 hello；2) 用编辑工具把 a.txt 改成 changed；3) 运行命令 echo x > probe2.txt；'
    + '4) 运行 Get-Content a.txt。逐项报告每一步是否被拒绝以及拒绝原因。';
  const result = await call('antigravity_ask', { prompt, workspace_dir: workspace, read_only: true, timeout_minutes: 10 });
  const files = fs.readdirSync(workspace).sort();
  report.cases.readonly = { status: result.status, errorCode: result.errorCode, files, a: fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'),
    recentTools: result.recentTools, response: result.response?.slice(0, 4000) };
  save();
  assert.deepEqual(files, ['a.txt']); assert.equal(report.cases.readonly.a, 'original\n');
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result).slice(0, 2000));
}

try {
  for (const [name, run] of [['readonly', readonlyCase], ['wait', waitCase], ['kill', killCase]]) {
    if (only !== 'all' && only !== name) continue;
    console.log('case', name, new Date().toISOString());
    try { await run(); report.cases[name].passed = true; }
    catch (error) { report.cases[name] = { ...report.cases[name], passed: false, error: String(error) }; console.error(name, error); }
    save();
  }
} finally { await client.close(); }
console.log(JSON.stringify(Object.fromEntries(Object.entries(report.cases).map(([key, value]) => [key, value.passed])), null, 2));
console.log('report:', path.join(directory, 'report.json'));
