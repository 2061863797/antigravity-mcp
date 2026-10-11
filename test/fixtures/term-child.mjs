import fs from 'node:fs';
// 用法：node term-child.mjs <graceful|ignore> <标记文件>
const [mode, marker] = process.argv.slice(2);
process.on('SIGTERM', () => {
  if (mode !== 'graceful') return;
  fs.writeFileSync(marker, 'SIGTERM');
  process.exit(0);
});
setInterval(() => {}, 1000);
process.stdout.write('ready');
