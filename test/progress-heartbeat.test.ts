import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'agy-heartbeat-'));
process.env.ANTIGRAVITY_MCP_STATE_HOME = path.join(root, 'state');
const { executeAgy, PROGRESS_HEARTBEAT_MS } = await import('../src/agy-executor.js');
const { taskTracker } = await import('../src/utils/task-tracker.js');
const cli = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
test.after(async () => { await taskTracker.shutdownAll(); fs.rmSync(root, { recursive: true, force: true }); });
const workspace = (name: string) => { const directory = path.join(root, name); fs.mkdirSync(directory); return directory; };

test('synchronous waits repeat the current stage as monotonic heartbeat progress', async () => {
  assert.equal(PROGRESS_HEARTBEAT_MS, 60000);
  const notes: Array<{ value: number; message: string }> = [];
  const result = await executeAgy({ prompt: 'FIXTURE:' + JSON.stringify({ delay: 1500 }), workspaceDir: workspace('sync'),
    cliPath: process.execPath, cliArgsPrefix: [cli], requestWaitTimeoutMs: 20000, progressHeartbeatMs: 200,
    onProgress: async (value, message) => { notes.push({ value, message }); } });
  assert.equal(result.status, 'SUCCESS');
  const beats = notes.filter(note => /: \d+s(:|$)/.test(note.message));
  assert(beats.length >= 2, JSON.stringify(notes));
  for (const beat of beats) assert(beat.message.includes(result.taskId!), beat.message);
  for (let index = 1; index < notes.length; index++) assert(notes[index].value > notes[index - 1].value, JSON.stringify(notes));
  assert.match(notes.at(-1)!.message, /^SUCCESS/);
  const count = notes.length; await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(notes.length, count, 'heartbeats stop once the wait settles');
});

test('asynchronous submissions send no heartbeat', async () => {
  const notes: string[] = [];
  const started = await executeAgy({ prompt: 'FIXTURE:' + JSON.stringify({ delay: 800 }), workspaceDir: workspace('async'), asyncMode: true,
    cliPath: process.execPath, cliArgsPrefix: [cli], progressHeartbeatMs: 100, onProgress: async (_value, message) => { notes.push(message); } });
  assert.equal(started.status, 'RUNNING');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(notes, []);
  const end = Date.now() + 15000;
  while (taskTracker.get(started.taskId!)?.result.status === 'RUNNING' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
});
