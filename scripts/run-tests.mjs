import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 显式传入文件路径，兼容 Windows cmd.exe 不展开通配符的 Node 20 测试入口。
const directory = fileURLToPath(new URL('../test/', import.meta.url));
const files = fs.readdirSync(directory).filter(name => name.endsWith('.test.ts')).sort().map(name => path.join(directory, name));
if (!files.length) throw new Error('No .test.ts files found');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--import', 'tsx', ...process.argv.slice(2), ...files],
  { stdio: 'inherit', windowsHide: true });
if (result.error) { console.error(result.error); process.exit(1); }
process.exit(result.status ?? 1);
