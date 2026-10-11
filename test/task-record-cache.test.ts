import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'agy-record-cache-'));
process.env.ANTIGRAVITY_MCP_STATE_HOME = root;
const { TaskTracker } = await import('../src/utils/task-tracker.js');
const { taskFile } = await import('../src/utils/task-store.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('remote task records are re-parsed only after the file changes', t => {
  const owner = new TaskTracker(), observer = new TaskTracker();
  const task = owner.create({ taskId: 'task_cache_probe', workspaceDir: root });
  const file = taskFile('task_cache_probe'), read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', ((...args: Parameters<typeof read>) => {
    if (path.resolve(String(args[0])) === file) reads++;
    return read(...args);
  }) as typeof read);
  const first = observer.get('task_cache_probe')!;
  assert.equal(first.remote, true); assert.equal(reads, 1);
  for (let index = 0; index < 5; index++) assert.equal(observer.get('task_cache_probe'), first);
  assert.equal(reads, 1, 'unchanged records must not be read again');
  owner.update(task, { activeTool: 'view_file' }); owner.persist(task, true);
  assert.equal(observer.get('task_cache_probe')!.result.activeTool, 'view_file'); assert.equal(reads, 2);
  fs.unlinkSync(file);
  assert.equal(observer.get('task_cache_probe'), undefined);
});
