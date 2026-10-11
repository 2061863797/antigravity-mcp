import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface WorkspaceSnapshot { head: string | null; entries: Map<string, string> }
const git = (cwd: string, args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  // 只读观察，避免 status 刷新索引时写入锁文件。
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
});

function fingerprint(root: string, file: string, deleted: boolean, buffer: Buffer): string {
  const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('Git path escapes the repository');
  let stat: fs.BigIntStats;
  try { stat = fs.lstatSync(absolute, { bigint: true }); }
  catch (error) {
    if (deleted && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  // 只观察链接本身；中间目录链接无法完整快照时省略结果，不读取外部目标。
  let parent = root;
  for (const component of relative.split(path.sep).slice(0, -1)) {
    parent = path.join(parent, component);
    if (fs.lstatSync(parent).isSymbolicLink()) throw new Error('Git path traverses a directory link');
  }
  if (stat.isSymbolicLink()) return 'link:' + crypto.createHash('sha256').update(fs.readlinkSync(absolute, { encoding: 'buffer' })).digest('hex');
  if (!stat.isFile()) throw new Error('Git path is not a regular file');
  const flags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const fd = fs.openSync(absolute, flags);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev) throw new Error('Git path changed while opening');
    const hash = crypto.createHash('sha256');
    let remaining = before.size;
    while (remaining > 0n) {
      const size = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining);
      const bytes = fs.readSync(fd, buffer, 0, size, null);
      if (!bytes) throw new Error('Git file changed while reading');
      hash.update(buffer.subarray(0, bytes)); remaining -= BigInt(bytes);
    }
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(absolute, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || current.ino !== before.ino || current.dev !== before.dev) throw new Error('Git file changed while reading');
    return 'file:' + (before.mode & 0o111n) + ':' + hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

// 非 git 目录或 git 命令失败时返回 undefined，调用方省略相关字段。
export function snapshotWorkspace(cwd: string): WorkspaceSnapshot | undefined {
  try {
    const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    let head: string | null = null;
    try { head = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).trim() || null; } catch { /* 尚无提交 */ }
    const entries = new Map<string, string>(), tokens = status.split('\0');
    if (!status) return { head, entries };
    const root = git(cwd, ['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '');
    const indexEntries = new Map<string, string>();
    for (const entry of git(root, ['ls-files', '--stage', '-z']).split('\0')) {
      const separator = entry.indexOf('\t'); if (separator < 0) continue;
      const file = entry.slice(separator + 1), metadata = entry.slice(0, separator);
      indexEntries.set(file, [indexEntries.get(file), metadata].filter(Boolean).join('\0'));
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]; if (token.length < 4) continue;
      const code = token.slice(0, 2), file = token.slice(3);
      // 重命名和复制的下一个字段是原路径。
      const source = /[RC]/.test(code) ? tokens[++index] : undefined;
      entries.set(file, [code, source ?? '', indexEntries.get(file) ?? '', fingerprint(root, file, code.includes('D'), buffer)].join('\0'));
    }
    return { head, entries };
  } catch { return undefined; }
}

export function compareWorkspace(before: WorkspaceSnapshot | undefined, after: WorkspaceSnapshot | undefined):
  { workspaceChanged: boolean; workspaceChangeSummary?: string[] } | undefined {
  if (!before || !after) return undefined;
  const changed = [...new Set([...before.entries.keys(), ...after.entries.keys()])]
    .filter(file => before.entries.get(file) !== after.entries.get(file)).sort();
  if (before.head === after.head && !changed.length) return { workspaceChanged: false };
  return { workspaceChanged: true, workspaceChangeSummary: changed.slice(0, 20) };
}
