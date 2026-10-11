import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { logger } from './logger.js';

let cachedAgyPath: string | null = null;
export const POSIX_SYSTEM_DIRECTORIES = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/var', '/System', '/Library', '/private'];

export function stripExtendedPrefix(p: string): string {
  if (process.platform === 'win32') {
    if (p.startsWith('\\\\?\\UNC\\')) {
      return '\\\\' + p.slice(8);
    }
    return p.replace(/^\\\\\?\\/, '');
  }
  return p;
}

export function canonicalPath(input: string): string {
  const full = path.resolve(input);
  try { return stripExtendedPrefix(fs.realpathSync.native(full)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(full);
    if (parent === full) throw error;
    return path.join(canonicalPath(parent), path.basename(full));
  }
}

/**
 * Locate the Antigravity CLI (agy.exe) binary.
 * 1. Check AGY_PATH environment variable
 * 2. Try where.exe agy (or PATH resolution)
 * 3. Check standard Windows AppData local path: %LOCALAPPDATA%\agy\bin\agy.exe
 */
export function getAgyExecutablePath(): string {
  // 1. Env variable
  if (process.env.AGY_PATH) {
    if (!fs.existsSync(process.env.AGY_PATH) || !fs.statSync(process.env.AGY_PATH).isFile()) throw new Error('AGY_NOT_FOUND: AGY_PATH must identify a CLI executable');
    cachedAgyPath = path.resolve(process.env.AGY_PATH);
    logger.debug(`Found agy via AGY_PATH: ${cachedAgyPath}`);
    return cachedAgyPath;
  }
  if (cachedAgyPath && fs.existsSync(cachedAgyPath)) return cachedAgyPath;

  // 2. Check where.exe on Windows or which on POSIX
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const output = execFileSync(command, ['agy'], {
      stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true
    }).trim();
    const firstMatch = output.split(/\r?\n/)[0]?.trim();
    if (firstMatch && fs.existsSync(firstMatch)) {
      cachedAgyPath = path.resolve(firstMatch);
      logger.debug(`Found agy via PATH: ${cachedAgyPath}`);
      return cachedAgyPath;
    }
  } catch {
    // ignore lookup error
  }

  // 3. Check %LOCALAPPDATA%\agy\bin\agy.exe
  const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : null);
  if (localAppData) {
    const defaultWinPath = path.join(localAppData, 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(defaultWinPath)) {
      cachedAgyPath = defaultWinPath;
      logger.debug(`Found agy at default AppData path: ${cachedAgyPath}`);
      return cachedAgyPath;
    }
  }

  throw new Error('AGY_NOT_FOUND: install agy or set AGY_PATH to its executable');
}

/**
 * Validate that a workspace directory is safe for automated execution.
 * Blocks root drive directories (e.g. C:\) and OS system directories (C:\Windows, etc.).
 * Also checks the physical target path via realpath to prevent symlink/junction bypass.
 */
export function validateWorkspaceSafety(dirPath: string): { safe: boolean; reason?: string } {
  let normalized = path.resolve(dirPath);
  try {
    if (fs.existsSync(normalized)) {
      normalized = fs.realpathSync(normalized);
    }
  } catch {}

  const parsed = path.parse(normalized);

  // Check 1: Root directory of any drive (e.g. 'C:\' or '/')
  if (normalized === parsed.root || normalized === parsed.root.slice(0, -1)) {
    return {
      safe: false,
      reason: `Operating in the root drive directory (${normalized}) is prohibited for safety reasons.`
    };
  }

  // Check 2: the user's home directory itself; its subdirectories remain allowed.
  const real = (value: string) => { try { return stripExtendedPrefix(fs.realpathSync.native(value)); } catch { return path.resolve(value); } };
  const same = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  const home = real(os.homedir());
  if (same(normalized, home) || same(stripExtendedPrefix(normalized), home)) {
    return { safe: false, reason: `Operating directly in the home directory (${normalized}) is prohibited; choose a project subdirectory.` };
  }

  // Check 3: POSIX system directories, including temporary directories inside them.
  if (process.platform !== 'win32') {
    const inside = (parent: string) => normalized === parent || normalized.startsWith(parent + '/');
    const blocked = POSIX_SYSTEM_DIRECTORIES.find(inside);
    if (blocked) {
      return { safe: false, reason: `Target workspace (${normalized}) is inside system directory ${blocked} and cannot be modified.` };
    }
  }

  // Check 4: Windows system directories
  if (process.platform === 'win32') {
    const winDir = (process.env.WINDIR || process.env.SYSTEMROOT || 'C:\\Windows').toLowerCase();
    const progFiles = (process.env['ProgramFiles'] || 'C:\\Program Files').toLowerCase();
    const progFilesX86 = (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase();
    const lowerNorm = normalized.toLowerCase();

    if (lowerNorm === winDir || lowerNorm.startsWith(winDir + '\\') || lowerNorm.startsWith(winDir + '/')) {
      return {
        safe: false,
        reason: `Target workspace (${normalized}) is inside Windows system directory and cannot be modified.`
      };
    }

    if (lowerNorm === progFiles || lowerNorm.startsWith(progFiles + '\\') || lowerNorm.startsWith(progFiles + '/') ||
        lowerNorm === progFilesX86 || lowerNorm.startsWith(progFilesX86 + '\\') || lowerNorm.startsWith(progFilesX86 + '/')) {
      return {
        safe: false,
        reason: `Target workspace (${normalized}) is inside Program Files and cannot be modified.`
      };
    }
  }

  return { safe: true };
}

/**
 * Validate and resolve a workspace directory.
 * If dirPath is specified, verifies that it exists and is a directory.
 * Implicit directory creation is forbidden to prevent silent misdirection.
 */
export function resolveWorkspaceDir(dirPath: string): string {
  if (!dirPath || !path.isAbsolute(dirPath)) throw new Error('INVALID_ARGUMENT: workspace_dir must be absolute');
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Workspace directory does not exist: "${dirPath}". Implicit directory creation is forbidden.`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Specified workspace path is not a directory: "${dirPath}".`);
  }
  return canonicalPath(resolved);
}
