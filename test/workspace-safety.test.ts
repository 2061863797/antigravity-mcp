import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'agy-safety-'));
const home = path.join(root, 'home'), project = path.join(home, 'projects', 'demo');
fs.mkdirSync(project, { recursive: true });
// 用临时目录代替真实家目录，避免测试依赖或触碰用户文件。
(os as unknown as { homedir: () => string }).homedir = () => home;
const { validateWorkspaceSafety, POSIX_SYSTEM_DIRECTORIES } = await import('../src/utils/paths.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('the home directory itself is rejected while its subdirectories stay allowed', () => {
  assert.equal(validateWorkspaceSafety(home).safe, false);
  assert.match(validateWorkspaceSafety(home).reason!, /home directory/);
  assert.equal(validateWorkspaceSafety(home + path.sep).safe, false);
  for (const allowed of [project, path.join(home, 'projects'), path.join(home, 'not-created-yet')]) {
    assert.equal(validateWorkspaceSafety(allowed).safe, true, allowed);
  }
  if (process.platform === 'win32') assert.equal(validateWorkspaceSafety(home.toUpperCase()).safe, false);
});

test('a link that resolves to the home directory is rejected', () => {
  const link = path.join(root, 'home-link');
  fs.symlinkSync(home, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(validateWorkspaceSafety(link).safe, false);
  assert.equal(validateWorkspaceSafety(path.join(link, 'projects', 'demo')).safe, true);
});

const posix = process.platform === 'win32' ? 'POSIX 系统目录规则不适用于 Windows 路径' : false;
for (const directory of POSIX_SYSTEM_DIRECTORIES) {
  test(`POSIX system directory ${directory} and its subdirectories are rejected`, { skip: posix }, () => {
    assert.equal(validateWorkspaceSafety(directory).safe, false);
    assert.equal(validateWorkspaceSafety(directory + '/agy-mcp-probe/nested').safe, false);
  });
}

test('POSIX prefix lookalikes and temporary workspaces stay allowed', { skip: posix }, () => {
  assert.equal(validateWorkspaceSafety('/etcetera-agy-mcp-probe').safe, true);
  assert.equal(validateWorkspaceSafety('/usrlocal-agy-mcp-probe/project').safe, true);
  assert.equal(validateWorkspaceSafety(project).safe, true);
});

test('a symlink inside an allowed directory that points into a system directory is rejected', { skip: posix }, () => {
  const link = path.join(root, 'etc-link');
  fs.symlinkSync('/etc', link, 'dir');
  assert.equal(validateWorkspaceSafety(link).safe, false);
});

test('Windows keeps rejecting drive roots and its system directories', { skip: process.platform !== 'win32' ? '仅 Windows 路径' : false }, () => {
  assert.equal(validateWorkspaceSafety('C:\\').safe, false);
  assert.equal(validateWorkspaceSafety(process.env.WINDIR ?? 'C:\\Windows').safe, false);
  assert.equal(validateWorkspaceSafety(path.join(root, 'project')).safe, true);
});
