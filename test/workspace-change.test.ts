import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'agy-change-'));
process.env.ANTIGRAVITY_MCP_STATE_HOME = path.join(root, 'state');
const { executeAgy } = await import('../src/agy-executor.js');
const { taskTracker } = await import('../src/utils/task-tracker.js');
const { compareWorkspace } = await import('../src/utils/workspace-change.js');
const cli = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
let gitMissing: string | false = false;
try { execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true }); } catch { gitMissing = '需要 git 可执行文件'; }
test.after(async () => { await taskTracker.shutdownAll(); fs.rmSync(root, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd, stdio: 'ignore', windowsHide: true });
function repository(name: string): string {
  const directory = path.join(root, name); fs.mkdirSync(directory, { recursive: true });
  git(directory, 'init', '-q'); fs.writeFileSync(path.join(directory, 'a.txt'), 'original');
  git(directory, 'add', '.'); git(directory, 'commit', '-q', '-m', 'init');
  return directory;
}
const run = (workspaceDir: string, input: Record<string, unknown>, analysis = true) => executeAgy({ prompt: 'FIXTURE:' + JSON.stringify(input),
  workspaceDir, analysis, cliPath: process.execPath, cliArgsPrefix: [cli], requestWaitTimeoutMs: 20000 });

test('ask reports workspace changes in a git repository without failing the task', { skip: gitMissing }, async () => {
  const workspace = repository('changed');
  const result = await run(workspace, { writes: { 'a.txt': 'edited', 'new/b.txt': 'created' } });
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.workspaceChanged, true);
  assert.deepEqual(result.workspaceChangeSummary, ['a.txt', 'new/b.txt']);
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'edited');
});

test('ask reports an unchanged git workspace explicitly', { skip: gitMissing }, async () => {
  const result = await run(repository('unchanged'), {});
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.workspaceChanged, false); assert(!('workspaceChangeSummary' in result));
});

test('non-git directories and code tasks omit the workspace change fields', { skip: gitMissing }, async () => {
  const plain = path.join(root, 'plain'); fs.mkdirSync(plain);
  const ask = await run(plain, { writes: { 'a.txt': 'edited' } });
  assert.equal(ask.status, 'SUCCESS'); assert(!('workspaceChanged' in ask)); assert(!('workspaceChangeSummary' in ask));
  const code = await run(repository('code'), { writes: { 'a.txt': 'edited' } }, false);
  assert.equal(code.status, 'SUCCESS'); assert(!('workspaceChanged' in code));
});

test('workspace change summary is limited to twenty paths and includes HEAD-only changes', () => {
  const entries = (count: number) => new Map(Array.from({ length: count }, (_, index) => [`f${String(index).padStart(2, '0')}.txt`, '??']));
  const many = compareWorkspace({ head: 'a', entries: new Map() }, { head: 'a', entries: entries(25) })!;
  assert.equal(many.workspaceChanged, true); assert.equal(many.workspaceChangeSummary!.length, 20);
  assert.deepEqual(compareWorkspace({ head: 'a', entries: new Map() }, { head: 'b', entries: new Map() }), { workspaceChanged: true, workspaceChangeSummary: [] });
  assert.equal(compareWorkspace(undefined, { head: 'a', entries: new Map() }), undefined);
});
