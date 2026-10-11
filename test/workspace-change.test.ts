import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testTempRoot } from './helpers/temp-root.js';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(testTempRoot(), 'agy-change-'));
// 项目内的夹具不能向上发现本仓库，否则非 Git 工作区用例会失去意义。
const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
process.env.GIT_CEILING_DIRECTORIES = root;
process.env.ANTIGRAVITY_MCP_STATE_HOME = path.join(root, 'state');
const { executeAgy } = await import('../src/agy-executor.js');
const { taskTracker } = await import('../src/utils/task-tracker.js');
const { compareWorkspace, snapshotWorkspace } = await import('../src/utils/workspace-change.js');
const cli = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
let gitMissing: string | false = false;
try { execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true }); } catch { gitMissing = '需要 git 可执行文件'; }
test.after(async () => {
  await taskTracker.shutdownAll(); fs.rmSync(root, { recursive: true, force: true });
  if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
});

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

test('ask detects changed contents in files that were already dirty or untracked', { skip: gitMissing }, async () => {
  const workspace = repository('already-dirty');
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'preexisting edit');
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'preexisting untracked file');
  const result = await run(workspace, { writes: { 'a.txt': 'another edit', 'notes.txt': 'changed untracked file' } });
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.workspaceChanged, true);
  assert.deepEqual(result.workspaceChangeSummary, ['a.txt', 'notes.txt']);
});

test('different staged contents are detected even when HEAD, porcelain flags and worktree contents stay identical', { skip: gitMissing }, () => {
  const workspace = repository('staged');
  const file = path.join(workspace, 'a.txt');
  fs.writeFileSync(file, 'first staged version'); git(workspace, 'add', 'a.txt'); fs.writeFileSync(file, 'unchanged worktree');
  const status = () => execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  const beforeStatus = status(), before = snapshotWorkspace(workspace);
  fs.writeFileSync(file, 'second staged version'); git(workspace, 'add', 'a.txt'); fs.writeFileSync(file, 'unchanged worktree');
  assert.equal(status(), beforeStatus);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unchanged worktree');
  assert.deepEqual(compareWorkspace(before, snapshotWorkspace(workspace)), { workspaceChanged: true, workspaceChangeSummary: ['a.txt'] });
});

test('dirty paths are resolved from the repository root when the execution directory is nested', { skip: gitMissing }, () => {
  const workspace = repository('nested 空格'), nested = path.join(workspace, 'nested'); fs.mkdirSync(nested);
  const file = path.join(workspace, 'a.txt'); fs.writeFileSync(file, 'first edit');
  const before = snapshotWorkspace(nested);
  fs.writeFileSync(file, 'second edit');
  assert.deepEqual(compareWorkspace(before, snapshotWorkspace(nested)), { workspaceChanged: true, workspaceChangeSummary: ['a.txt'] });
});

test('file hashing consumes every chunk and a persistent deletion remains unchanged', { skip: gitMissing }, () => {
  const workspace = repository('chunks'), file = path.join(workspace, 'data.bin');
  const bytes = Buffer.alloc(2 * 64 * 1024 + 7, 1); fs.writeFileSync(file, bytes);
  const before = snapshotWorkspace(workspace); bytes[bytes.length - 1] = 2; fs.writeFileSync(file, bytes);
  assert.deepEqual(compareWorkspace(before, snapshotWorkspace(workspace)), { workspaceChanged: true, workspaceChangeSummary: ['data.bin'] });
  fs.unlinkSync(path.join(workspace, 'a.txt'));
  assert.deepEqual(compareWorkspace(snapshotWorkspace(workspace), snapshotWorkspace(workspace)), { workspaceChanged: false });
});

test('an unreadable dirty file omits change fields instead of claiming an unchanged workspace', { skip: gitMissing }, t => {
  const workspace = repository('unreadable'), file = path.join(workspace, 'a.txt'); fs.writeFileSync(file, 'dirty');
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', ((...args: Parameters<typeof open>) => {
    if (path.resolve(String(args[0])) === file) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    return open(...args);
  }) as typeof open);
  assert.equal(snapshotWorkspace(workspace), undefined);
  assert.equal(compareWorkspace(undefined, { head: 'same', entries: new Map() }), undefined);
});

test('link snapshots compare link targets without opening the external file on any platform', { skip: gitMissing }, t => {
  const workspace = repository('link'), file = path.join(workspace, 'link.txt'); fs.writeFileSync(file, 'placeholder');
  let target = 'outside-first';
  const lstat = fs.lstatSync, readlink = fs.readlinkSync, open = fs.openSync;
  t.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof lstat>) => {
    const stat = lstat(...args);
    if (path.resolve(String(args[0])) !== file) return stat;
    assert(stat);
    const link = Object.create(stat); link.isSymbolicLink = () => true; return link;
  }) as typeof lstat);
  t.mock.method(fs, 'readlinkSync', ((...args: Parameters<typeof readlink>) =>
    path.resolve(String(args[0])) === file ? Buffer.from(target) : readlink(...args)) as typeof readlink);
  t.mock.method(fs, 'openSync', ((...args: Parameters<typeof open>) => {
    assert.notEqual(path.resolve(String(args[0])), file, 'a link target must not be opened'); return open(...args);
  }) as typeof open);
  const before = snapshotWorkspace(workspace); target = 'outside-second';
  assert.deepEqual(compareWorkspace(before, snapshotWorkspace(workspace)), { workspaceChanged: true, workspaceChangeSummary: ['link.txt'] });
});

test('non-git directories and code tasks omit the workspace change fields', { skip: gitMissing }, async () => {
  const plain = path.join(root, 'plain'); fs.mkdirSync(plain);
  assert.throws(() => git(plain, 'rev-parse', '--show-toplevel'), 'plain fixture must be outside any Git repository');
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
