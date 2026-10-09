import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 普通检查不执行真实模型；授权后显式打开此开关。
if (process.env.ANTIGRAVITY_LIVE_TESTS !== '1') throw new Error('Real model acceptance requires authorization and ANTIGRAVITY_LIVE_TESTS=1.');
const root = fileURLToPath(new URL('../', import.meta.url)), base = path.join(root, 'audit', 'live-v3');
fs.mkdirSync(base, { recursive: true });
const directory = fs.mkdtempSync(path.join(base, 'acceptance-')), workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
const cli = process.env.AGY_PATH ?? (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe') : 'agy');
const runFile = promisify(execFile), cliVersion = (await runFile(cli, ['--version'], { windowsHide: true, timeout: 10000 })).stdout.trim();
fs.writeFileSync(path.join(workspace, 'sum.cjs'), 'module.exports = () => { throw new Error("not implemented"); };\n');
fs.writeFileSync(path.join(workspace, 'sum.test.cjs'), [
  "const test=require('node:test'),assert=require('node:assert/strict'),sum=require('./sum.cjs');",
  "test('empty',()=>assert.equal(sum([]),0));",
  "test('numbers',()=>assert.equal(sum([1,-2,3]),2));",
  "test('frozen input',()=>assert.equal(sum(Object.freeze([2,3])),5));",
  "test('invalid',()=>{for(const value of [null,{},[NaN],[Infinity],[1,'2']])assert.throws(()=>sum(value),TypeError);});"
].join('\n'));
fs.writeFileSync(path.join(workspace, 'protected.txt'), 'independent sentinel\n');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes = () => Object.fromEntries(fs.readdirSync(workspace).sort().map(name => [name, hash(path.join(workspace, name))]));
const baseline = hashes(), report = { cliVersion, workspace, model: 'gemini-3.8-flash-high', effort: 'high', cases: [], passed: false };
const client = new Client({ name: 'agy-channel-live', version: '3' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [path.resolve(process.env.ANTIGRAVITY_LIVE_SERVER ?? path.join(root, 'dist/index.js'))], env: { ...process.env, AGY_PATH: cli }, stderr: 'pipe' });
let activeTask;
const data = value => { assert(value.structuredContent); assert.deepEqual(JSON.parse(value.content[0].text), value.structuredContent);
  return value.structuredContent.kind === 'task' ? value.structuredContent.data : value.structuredContent; };
const invoke = async (label, name, args) => {
  let result = data(await client.callTool({ name, arguments: { ...args, workspace_dir: workspace,
    model: report.model, effort: report.effort, async_mode: true, execution_timeout_minutes: 5 } }));
  activeTask = result.taskId;
  while (result.status === 'RUNNING') {
    result = data(await client.callTool({ name: 'antigravity_status',
      arguments: { task_id: activeTask, after_revision: result.revision, wait_ms: 20000 } }));
    if (result.status === 'RUNNING' && result.errorCode) throw new Error(JSON.stringify(result));
  }
  activeTask = undefined; report.cases.push({ label, result });
  console.log(JSON.stringify({ label, taskId: result.taskId, status: result.status, elapsedSeconds: result.elapsedSeconds }));
  return result;
};
try {
  await client.connect(transport);
  transport.stderr?.on('data', chunk => fs.appendFileSync(path.join(directory, 'server.log'), chunk));
  assert.equal((await client.listTools()).tools.length, 4);
  const review = await invoke('ask', 'antigravity_ask', { prompt: 'Read sum.cjs and its tests. Explain what needs implementing. Do not edit files.' });
  assert.equal(review.status, 'SUCCESS'); assert.equal(review.executionWorkspaceDir, workspace); assert.deepEqual(hashes(), baseline);
  assert.equal(review.cliMode, 'accept-edits'); assert.equal(review.autoApprove, true);
  const code = await invoke('code', 'antigravity_code', { prompt: 'Implement sum(values) in sum.cjs: require an array of finite numbers; return the sum and 0 for empty input; throw TypeError otherwise; do not mutate input. Edit only sum.cjs. Do not install dependencies.' });
  assert.equal(code.status, 'SUCCESS'); assert(!('verification' in code)); assert(code.conversationId); assert.equal(code.autoApprove, true);
  assert.equal(hash(path.join(workspace, 'sum.test.cjs')), baseline['sum.test.cjs']);
  assert.equal(hash(path.join(workspace, 'protected.txt')), baseline['protected.txt']);
  // 验收由父调用方执行，不作为 MCP 调用成功的条件。
  report.independentTest = await runFile(process.execPath, ['--test', 'sum.test.cjs'], { cwd: workspace, windowsHide: true, timeout: 20000 });
  const continued = await invoke('continuation', 'antigravity_ask', { prompt: 'Explain the current implementation without editing files.',
    conversation_id: code.conversationId });
  assert.equal(continued.status, 'SUCCESS'); assert.equal(continued.conversationId, code.conversationId); assert.equal(continued.autoApprove, true);
  report.passed = true;
} catch (error) {
  report.error = String(error); process.exitCode = 1;
} finally {
  if (activeTask) try { await client.callTool({ name: 'antigravity_cancel_task', arguments: { task_id: activeTask } }); } catch {}
  await client.close();
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.passed, reportPath: path.join(directory, 'report.json') }));
