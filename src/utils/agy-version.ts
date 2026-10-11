import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// 官方 changelog：1.1.15 修复 stream-json 非 ASCII 文本；此前版本已提供本项目使用的参数。
export const MIN_AGY_VERSION = '1.1.15';
const cache = new Map<string, string>();
export class AgyVersionError extends Error {
  constructor(public readonly code: 'AGY_VERSION_UNSUPPORTED' | 'AGY_VERSION_UNREADABLE', message: string) {
    super(code + ': ' + message);
  }
}

export function parseAgyVersion(output: string): string | undefined {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const pattern = /(?<![\w.])v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?![\w.+-])/g;
  const versions = [...new Set([...text.matchAll(pattern)].map(match => match[1]))];
  if (versions.length !== 1) return undefined;
  const version = versions[0];
  const [core, prerelease] = version.split('+')[0].split(/-(.*)/s);
  if (!core.split('.').every(value => Number.isSafeInteger(Number(value)))) return undefined;
  if (prerelease?.split('.').some(value => /^\d+$/.test(value) && value.length > 1 && value.startsWith('0'))) return undefined;
  return version;
}

function supportsMinimum(version: string): boolean {
  const core = version.split(/[+-]/)[0].split('.').map(Number), minimum = MIN_AGY_VERSION.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (core[index] !== minimum[index]) return core[index] > minimum[index];
  return !version.split('+')[0].includes('-');
}

export async function ensureAgyVersion(executable: string, prefix: string[] = [], options: {
  cwd?: string; signal?: AbortSignal
} = {}): Promise<string | undefined> {
  const abort = () => { if (options.signal?.aborted) throw new Error('CANCELLED'); };
  abort();
  if (process.env.ANTIGRAVITY_SKIP_VERSION_CHECK === '1') return undefined;
  try {
    const executablePath = fs.realpathSync.native(executable), executableStat = fs.statSync(executablePath);
    if (!executableStat.isFile()) throw new Error('CLI path is not a file');
    // 包装脚本也是实际命令的一部分，避免共享 Node 等解释器时混用不同 CLI 的版本。
    const wrappers = prefix.map(arg => {
      const file = path.resolve(options.cwd ?? process.cwd(), arg);
      try { const stat = fs.statSync(file); return stat.isFile() ? [file, stat.mtimeMs] : null; }
      catch { return null; }
    });
    // 只有相对路径的前缀参数依赖工作目录；绝对路径前缀在不同目录间共享缓存。
    const key = JSON.stringify([executablePath, executableStat.mtimeMs, prefix, wrappers, prefix.some(arg => !path.isAbsolute(arg)) ? options.cwd : null]);
    const cached = cache.get(key); if (cached) return cached;
    const { stdout, stderr } = await promisify(execFile)(executable, [...prefix, '--version'], {
      cwd: options.cwd, signal: options.signal, timeout: 10000, windowsHide: true, encoding: 'utf8', maxBuffer: 8192
    });
    abort();
    const version = parseAgyVersion(stdout + '\n' + stderr);
    if (!version) throw new AgyVersionError('AGY_VERSION_UNREADABLE', '无法解析 agy --version 输出。检查 AGY_PATH 和 CLI；必要时明确设置 ANTIGRAVITY_SKIP_VERSION_CHECK=1 跳过版本预检。');
    if (!supportsMinimum(version)) throw new AgyVersionError('AGY_VERSION_UNSUPPORTED', `当前 agy ${version}，最低要求 ${MIN_AGY_VERSION}；请升级 agy 后重新提交。`);
    cache.set(key, version);
    return version;
  } catch (error) {
    abort();
    if (error instanceof AgyVersionError) throw error;
    throw new AgyVersionError('AGY_VERSION_UNREADABLE', `无法取得 agy 版本：${String(error).slice(-2048)}。检查 AGY_PATH 和 CLI；必要时明确设置 ANTIGRAVITY_SKIP_VERSION_CHECK=1 跳过版本预检。`);
  }
}
