import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.resolve(root, 'dist');
if (path.dirname(target) !== path.resolve(root) || path.basename(target) !== 'dist') throw new Error('Unsafe build target');
if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Refusing linked dist');
fs.rmSync(target, { recursive: true, force: true });
