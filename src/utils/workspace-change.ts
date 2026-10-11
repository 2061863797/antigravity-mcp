import { execFileSync } from 'node:child_process';

export interface WorkspaceSnapshot { head: string | null; entries: Map<string, string> }
const git = (cwd: string, args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  // 只读观察，避免 status 刷新索引时写入锁文件。
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
});

// 非 git 目录或 git 命令失败时返回 undefined，调用方省略相关字段。
export function snapshotWorkspace(cwd: string): WorkspaceSnapshot | undefined {
  try {
    const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    let head: string | null = null;
    try { head = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).trim() || null; } catch { /* 尚无提交 */ }
    const entries = new Map<string, string>(), tokens = status.split('\0');
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]; if (token.length < 4) continue;
      const code = token.slice(0, 2), file = token.slice(3);
      // 重命名和复制的下一个字段是原路径。
      const source = /[RC]/.test(code) ? tokens[++index] : undefined;
      entries.set(file, code + (source === undefined ? '' : '\0' + source));
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
