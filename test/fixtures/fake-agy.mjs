import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2), prompt = args[args.indexOf('-p') + 1] ?? '';
if (args.includes('--version')) {
  if (process.env.TEST_VERSION_STARTS) fs.appendFileSync(process.env.TEST_VERSION_STARTS, 'version\n');
  console.log(process.env.TEST_AGY_VERSION ?? 'agy 1.3.0');
  process.exit(0);
}
const input = JSON.parse(prompt.split('\n').find(line => line.startsWith('FIXTURE:'))?.slice(8) ?? '{}');
if (prompt === '/usage') {
  const file = path.resolve('.quota-fixture.json'), fixture = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (fixture.capture) fs.appendFileSync(fixture.capture, JSON.stringify({ args, pid: process.pid }) + '\n');
  if (fixture.delay) await new Promise(resolve => setTimeout(resolve, fixture.delay));
  const data = fixture.data ?? { groups: [{ name: 'Gemini Models', buckets: [
    { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9, reset_time: '2050-10-13T14:27:34Z' },
    { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.8, reset_time: '2050-10-08T14:09:09Z' }
  ] }] };
  const command = { name: 'usage', data };
  const result = { status: fixture.error ? 'ERROR' : 'SUCCESS', conversation_id: '', response: 'native quota', command, ...(fixture.error || fixture.successError ? { error: fixture.error || fixture.successError } : {}) };
  const text = fixture.malformed ? 'invalid NDJSON\n' : JSON.stringify({ event: 'command_result', command }) + '\n' + JSON.stringify({ event: 'result', result }) + '\n';
  await new Promise(resolve => process.stdout.write(text, resolve));
  process.exit(fixture.error ? 1 : 0);
}
if (process.env.TEST_MODEL_STARTS) fs.appendFileSync(process.env.TEST_MODEL_STARTS, 'start\n');
if (input.capture) fs.writeFileSync(input.capture, JSON.stringify({ args, cwd: process.cwd(), user: os.userInfo().username, envProbe: process.env.TEST_WORKER_TEXT }));
if (input.stderr) process.stderr.write(input.stderr + '\n');
if (input.stderrBytes) {
  for (let remaining = input.stderrBytes; remaining > 0; remaining -= 70000) await new Promise(resolve => process.stderr.write('x'.repeat(Math.min(remaining, 70000)), resolve));
}
if (input.stderrChunks) for (const part of input.stderrChunks) {
  const chunk = typeof part === 'string' ? Buffer.from(part) : Buffer.from(part);
  await new Promise(resolve => process.stderr.write(chunk, resolve));
  await new Promise(resolve => setTimeout(resolve, 20));
}
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const conversation = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : crypto.randomUUID();
if (!input.silent) {
  send({ event: 'init', conversation_id: conversation, init: { permission_mode: args.includes('--dangerously-skip-permissions') ? 'always-proceed' : 'request-review' } });
  const step = { conversation_id: conversation, step_index: 1, step_type: 'tool', tool_name: 'view_file',
    tool_info: { parameters: { AbsolutePath: path.resolve('a.txt') } } };
  send({ event: 'step_update', step_update: { ...step, state: 'ACTIVE' } });
  send({ event: 'step_update', step_update: { ...step, state: 'ACTIVE' } });
  send({ event: 'step_update', step_update: { ...step, state: 'DONE' } });
  for (const step_update of input.steps ?? []) {
    if (input.stepDelay) await new Promise(resolve => setTimeout(resolve, input.stepDelay));
    send({ event: 'step_update', step_update: { conversation_id: conversation, ...step_update } });
  }
}
for (const [name, content] of Object.entries(input.writes ?? {})) {
  fs.mkdirSync(path.dirname(path.resolve(name)), { recursive: true }); fs.writeFileSync(name, content);
}
if (input.descendants) {
  const file = path.resolve('descendant.pid'), grandchild = input.grandchild ? path.resolve('grandchild.pid') : undefined;
  const code = grandchild
    ? "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(" + JSON.stringify(grandchild) + ",String(c.pid));c.unref();"
    : 'setInterval(()=>{},1000)';
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
  fs.writeFileSync(file, String(child.pid)); child.unref();
  if (grandchild) for (let attempt = 0; !fs.existsSync(grandchild) && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
}
if (input.hang) await new Promise(() => setInterval(() => {}, 1000));
if (input.delay) await new Promise(resolve => setTimeout(resolve, input.delay));
if (input.flood) for (let index = 0; index < 90; index++) send({ event: 'future_output', data: 'x'.repeat(70000) });
if (input.unknown) send({ event: 'future_status', status: 'SUCCESS', response: 'not a result' });
const result = { status: input.status ?? (input.error ? 'ERROR' : 'SUCCESS'), response: input.response ?? '任务已完成。',
  conversation_id: input.resultConversationId ?? conversation, usage: input.usage ?? { input_tokens: 12, output_tokens: 4 }, duration_seconds: input.duration ?? 123 };
if (input.error) result.error = input.error;
if (input.successError) result.error = input.successError;
if (input.rawOutput) process.stdout.write(input.rawOutput);
if (input.malformed) process.stdout.write('invalid final output\n');
else if (!input.omitResult) send({ event: 'result', result });
process.exitCode = input.exitCode ?? 0;
