import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateWorkspaceSafety } from '../../src/utils/paths.js';

// macOS 的系统临时目录位于受保护的 /private 下；测试夹具也必须遵守工作区规则。
export function testTempRoot(): string {
  const temporary = fs.realpathSync.native(os.tmpdir());
  if (validateWorkspaceSafety(temporary).safe) return temporary;
  const fallback = fileURLToPath(new URL('../../.verify-out/test-workspaces/', import.meta.url));
  fs.mkdirSync(fallback, { recursive: true });
  const resolved = fs.realpathSync.native(fallback);
  if (!validateWorkspaceSafety(resolved).safe) throw new Error('测试需要位于允许工作区内的临时目录');
  return resolved;
}
