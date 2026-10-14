import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output-dir')) throw new Error('用法：node scripts/package-plugin.mjs [--output-dir 目录]');
if (process.platform !== 'win32') throw new Error('本打包脚本使用 Windows 自带 tar.exe。');
const output = path.resolve(args[1] ?? path.join(root, 'release'));
const name = `antigravity-mcp-plugin-${pkg.version}`;
const destination = path.join(output, name);
const archive = path.join(output, `${name}.zip`);
const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const run = (command, arguments_, cwd = root) => execFileSync(command, arguments_, {
  cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
});

// 只删除本次生成的暂存目录或准确命名的发布产物，不追随目录链接。
function checkTree(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`不处理链接：${target}`);
  if (stat.isDirectory()) for (const entry of fs.readdirSync(target)) checkTree(path.join(target, entry));
}
function copy(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`不复制链接：${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) copy(path.join(source, entry), path.join(target, entry));
  } else if (stat.isFile()) fs.copyFileSync(source, target);
  else throw new Error(`不复制特殊文件：${source}`);
}
function removeOwned(target) {
  const relative = path.relative(output, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('清理目标超出发布目录');
  if (fs.existsSync(target)) { checkTree(target); fs.rmSync(target, { recursive: true, force: true }); }
}
function npmCli() {
  const locations = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  if (!locations.some(value => value && fs.existsSync(value))) {
    const npm = run('where.exe', ['npm.cmd']).trim().split(/\r?\n/)[0];
    locations.push(path.join(path.dirname(npm), 'node_modules/npm/bin/npm-cli.js'));
  }
  const found = locations.find(value => value && fs.existsSync(value));
  if (!found) throw new Error('未找到 npm CLI；请安装带 npm 的 Node.js。');
  return found;
}

for (const file of ['dist/index.js', 'dist/task-worker.js', 'dist/hook-wait.js','config.json', 'LICENSE', 'plugin/skills/antigravity-delegation/SKILL.md', 'plugin/install.ps1']) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`缺少 ${file}；先构建并准备插件。`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin/plugin.json'), 'utf8'));
const claudeManifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin/claude-plugin.json'), 'utf8'));
for (const item of [manifest, claudeManifest]) {
  if (item.version !== pkg.version || item.name !== 'antigravity-mcp') throw new Error('插件与包版本或名称不一致');
}
fs.mkdirSync(output, { recursive: true });
if (fs.lstatSync(output).isSymbolicLink()) throw new Error('发布目录不能是链接');
const staging = fs.mkdtempSync(path.join(output, '.plugin-build-'));
try {
  // npm 从已安装依赖中收集生产依赖闭包；离线打包，不安装依赖、不运行生命周期脚本。
  const packed = JSON.parse(run(process.execPath, [npmCli(), 'pack', '--offline', '--ignore-scripts', '--json',
    '--cache', path.join(staging, 'npm-cache'), '--pack-destination', staging]))[0];
  // 部分 Windows tar 使用系统代码页解码参数；工作目录走原生路径，参数仅用 ASCII 相对路径。
  const entries = run(tar, ['-tf', packed.filename], staging).trim().split(/\r?\n/);
  if (entries.some(entry => !entry.startsWith('package/') || entry.split('/').includes('..'))) throw new Error('npm 包路径无效');
  const unpack = path.join(staging, 'unpack'); fs.mkdirSync(unpack);
  run(tar, ['-xf', packed.filename, '-C', 'unpack'], staging);
  const npmPackage = path.join(unpack, 'package'); checkTree(npmPackage);
  const bundle = path.join(staging, name);
  const plugin = path.join(bundle, 'plugins/antigravity-mcp');
  const runtime = path.join(plugin, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  for (const entry of ['plugin.json', 'mcp.json', 'skills']) copy(path.join(root, 'plugin', entry), path.join(plugin, entry));
  for (const entry of ['config.json', 'LICENSE', 'dist', 'node_modules']) copy(path.join(npmPackage, entry), path.join(runtime, entry));
  copy(path.join(root, 'LICENSE'), path.join(plugin, 'LICENSE'));
  copy(path.join(root, 'LICENSE'), path.join(bundle, 'LICENSE'));
  const { name: runtimeName, version, description, type, main, engines, license, dependencies } = pkg;
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name: runtimeName, version, description,
    type, main, engines, license, dependencies }, null, 2) + '\n');
  // 同一目录同时是 Codex（.agents/plugins）和 Claude Code（.claude-plugin）的本地市场，共用运行时与 Skill。
  fs.mkdirSync(path.join(bundle, '.agents/plugins'), { recursive: true });
  fs.copyFileSync(path.join(root, 'plugin/marketplace.json'), path.join(bundle, '.agents/plugins/marketplace.json'));
  fs.mkdirSync(path.join(bundle, '.claude-plugin'), { recursive: true });
  fs.copyFileSync(path.join(root, 'plugin/claude-marketplace.json'), path.join(bundle, '.claude-plugin/marketplace.json'));
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.copyFileSync(path.join(root, 'plugin/claude-plugin.json'), path.join(plugin, '.claude-plugin/plugin.json'));
  fs.copyFileSync(path.join(root, 'plugin/install.ps1'), path.join(bundle, 'install.ps1'));
  fs.copyFileSync(path.join(root, 'plugin/README.md'), path.join(bundle, 'README.md'));
  if (!packed.bundled?.includes('@modelcontextprotocol/sdk') || !packed.bundled?.includes('zod')) throw new Error('npm 未包含必要生产依赖');
  const zip = path.join(staging, `${name}.zip`);
  run(tar, ['-a', '-cf', `${name}.zip`, name], staging);
  // 已有目标必须是本插件的发布目录，避免覆盖其他用户资料。
  if (fs.existsSync(destination)) {
    const old = JSON.parse(fs.readFileSync(path.join(destination, 'plugins/antigravity-mcp/plugin.json'), 'utf8'));
    if (old.name !== manifest.name || old.version !== pkg.version) throw new Error('已有目录不是本版本发布产物');
  }
  removeOwned(destination); removeOwned(archive);
  // 部分环境（如沙箱或虚拟化目录）对同盘重命名也报 EXDEV；此时改为复制，避免旧目录已删、新目录未就位。
  const place = (source, target, directory) => {
    try { fs.renameSync(source, target); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      if (directory) copy(source, target); else fs.copyFileSync(source, target);
    }
  };
  place(bundle, destination, true); place(zip, archive, false);
  console.log(JSON.stringify({ directory: destination, zip: archive, zipBytes: fs.statSync(archive).size,
    bundledPackages: packed.bundled.length }, null, 2));
} finally { removeOwned(staging); }
