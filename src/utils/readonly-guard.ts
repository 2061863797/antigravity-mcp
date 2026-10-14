import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// 只读任务通过 agy 的 PreToolUse 钩子硬性拦截写入。钩子装在 agy 全局插件目录，
// 只有 MCP 启动的只读任务在 agy 环境中带 READONLY_ENV 时才会启动判定脚本，其他 agy 会话不受影响。
// 实测 agy 1.3.4：钩子没有任何输出才是中性放行；输出 {}、空 decision 或钩子报错都会被当作拒绝。
export const READONLY_ENV = 'ANTIGRAVITY_MCP_READONLY';
export const READONLY_PLUGIN = 'antigravity-mcp-readonly';
export const READ_TOOLS = ['view_file', 'view_file_outline', 'view_code_item', 'list_dir', 'grep_search', 'find_by_name', 'codebase_search',
  'search_in_file', 'read_url_content', 'search_web', 'command_status', 'read_terminal', 'read_resource', 'list_resources', 'task_boundary', 'notify_user'];

// 判定一次工具调用；返回 null 表示放行（不输出），字符串为拒绝原因。
// 该函数会被序列化进守卫脚本独立运行，不能引用模块内的其他绑定。
export function evaluateToolCall(name: unknown, args: unknown): string | null {
  const reads = ['view_file', 'view_file_outline', 'view_code_item', 'list_dir', 'grep_search', 'find_by_name', 'codebase_search',
    'search_in_file', 'read_url_content', 'search_web', 'command_status', 'read_terminal', 'read_resource', 'list_resources', 'task_boundary', 'notify_user'];
  const deny = (why: string) => 'read_only mode: ' + why + ' Only reading files, searching and read-only commands are allowed; report findings in your answer instead of changing anything.';
  if (typeof name !== 'string') return deny('unknown tool call.');
  if (reads.includes(name)) return null;
  if (name !== 'run_command') return deny('tool "' + name + '" may modify files or have side effects.');
  const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const line = typeof input.CommandLine === 'string' ? input.CommandLine.trim() : '';
  if (!line) return deny('empty command.');
  // 拒绝重定向、串联、子表达式、脚本块和换行；管道只允许连接白名单命令。
  if (/[<>;&`$(){}\r\n]/.test(line) || /\|\|/.test(line)) return deny('redirection, command chaining, subexpressions and script blocks are not allowed.');
  const simple = ['get-childitem', 'gci', 'ls', 'dir', 'get-content', 'gc', 'cat', 'type', 'select-string', 'sls', 'get-item', 'gi',
    'test-path', 'resolve-path', 'get-location', 'pwd', 'get-filehash', 'get-command', 'measure-object', 'measure', 'select-object', 'select',
    'sort-object', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'get-itemproperty', 'split-path', 'join-path',
    'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'findstr', 'tree', 'stat', 'file', 'which', 'where', 'where.exe', 'whoami', 'echo',
    'diff', 'cmp', 'du', 'realpath', 'dirname', 'basename', 'rg', 'find', 'sort', 'git'];
  const gitRead = ['status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'cat-file', 'rev-list', 'merge-base', 'name-rev', '--version', 'version'];
  for (const segment of line.split('|')) {
    const words = segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    if (!words.length) return deny('empty pipeline segment.');
    const command = (words[0] ?? '').replace(/^["']|["']$/g, '').toLowerCase().replace(/\.exe$/, '').split(/[\\/]/).pop() ?? '';
    const rest = words.slice(1).map(word => word.replace(/^["']|["']$/g, ''));
    const lower = rest.map(word => word.toLowerCase());
    if (!simple.includes(command) && !simple.includes(command + '.exe')) return deny('command "' + command + '" is not on the read-only allowlist.');
    if (lower.some(word => /^-(outfile|outvariable|ov|pipelinevariable|pv)\b/.test(word))) return deny('output parameters are not allowed.');
    if (command === 'git') {
      let index = 0;
      // 子命令前只允许 --no-pager 和 -C <目录>；-c 等可注入配置或外部程序。
      while (index < rest.length && rest[index].startsWith('-') && !gitRead.includes(lower[index])) {
        if (rest[index] === '--no-pager') index++;
        else if (rest[index] === '-C') index += 2;
        else return deny('git option "' + rest[index] + '" is not allowed.');
      }
      if (!gitRead.includes(lower[index] ?? '')) return deny('git subcommand "' + (rest[index] ?? '') + '" is not read-only.');
      if (lower.some(word => /^--(output|ext-diff|exec|upload-pack|open-files-in-pager|textconv)\b/.test(word) || word === '-o')) return deny('git output or external-program options are not allowed.');
    }
    if (command === 'rg' && lower.some(word => /^--pre\b/.test(word))) return deny('rg --pre runs external programs.');
    if (command === 'find' && lower.some(word => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(word))) return deny('find actions that execute or write are not allowed.');
    if (command === 'sort' && lower.some(word => /^(-o|\/o|--output)/.test(word))) return deny('sort output files are not allowed.');
  }
  return null;
}

// 守卫脚本：只在激活时被包装脚本启动；记录每次判定，异常时拒绝（偏安全）。
export function guardScript(): string {
  return `// 由 antigravity-mcp 自动生成，用于只读任务；请勿手工修改。
import fs from 'node:fs';
// 部分转译器会给函数插入 __name 包装；独立运行时提供同名空实现。
const __name = (target) => target;
const evaluateToolCall = ${evaluateToolCall.toString()};
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  let reason;
  let name = null;
  try {
    const call = JSON.parse(data || '{}').toolCall ?? {};
    name = typeof call.name === 'string' ? call.name : null;
    reason = evaluateToolCall(call.name, call.args);
  } catch (error) { reason = 'read_only mode: guard could not parse the tool call, so it was blocked.'; }
  try { fs.appendFileSync(process.env.${READONLY_ENV}, JSON.stringify({ tool: name, denied: reason !== null }) + '\\n'); } catch {}
  if (reason !== null) process.stdout.write(JSON.stringify({ decision: 'deny', reason }));
});
`;
}

const pluginDir = () => path.join(os.homedir(), '.gemini', 'config', 'plugins', READONLY_PLUGIN);
function windowsWrapper(node: string): string {
  // 未激活时读掉标准输入并以 0 退出、不输出任何内容，保持 agy 默认行为。
  return ['@echo off', `if not defined ${READONLY_ENV} (more >nul & exit /b 0)`, `"${node}" "%~dp0guard.mjs"`, 'exit /b %ERRORLEVEL%', ''].join('\r\n');
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
function posixWrapper(node: string, dir: string): string {
  return ['#!/bin/sh', `if [ -z "$${READONLY_ENV}" ]; then cat >/dev/null; exit 0; fi`, `exec ${quote(node)} ${quote(path.join(dir, 'guard.mjs'))}`, ''].join('\n');
}
// agy 在 Windows 上用 cmd /c 执行钩子命令，并会把命令里的引号转义坏；命令里不能带引号或空格。
function windowsCommand(file: string): string {
  if (!/[\s"&^%!()]/.test(file)) return file;
  const short = execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    ['/d', '/c', `for %I in ("${file}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true }).trim();
  if (!short || /[\s"&^%!()]/.test(short)) throw new Error('guard path contains spaces and no 8.3 short name is available: ' + file);
  return short;
}
function writeIfChanged(file: string, content: string): void {
  try { if (fs.readFileSync(file, 'utf8') === content) return; } catch { /* 不存在时写入。 */ }
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o755 });
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

// 幂等安装或修复守卫插件；内容一致时不改动文件。失败时抛出 READONLY_GUARD_UNAVAILABLE，调用方不得降级运行。
export function ensureReadonlyGuard(node = process.execPath): string {
  try {
    const dir = pluginDir();
    fs.mkdirSync(dir, { recursive: true });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('guard plugin directory must not be a link');
    writeIfChanged(path.join(dir, 'plugin.json'), JSON.stringify({ name: READONLY_PLUGIN }) + '\n');
    writeIfChanged(path.join(dir, 'guard.mjs'), guardScript());
    let command: string;
    if (process.platform === 'win32') {
      writeIfChanged(path.join(dir, 'guard.cmd'), windowsWrapper(node));
      command = windowsCommand(path.join(dir, 'guard.cmd'));
    } else {
      writeIfChanged(path.join(dir, 'guard.sh'), posixWrapper(node, dir));
      command = 'sh ' + quote(path.join(dir, 'guard.sh'));
    }
    writeIfChanged(path.join(dir, 'hooks.json'), JSON.stringify({ [READONLY_PLUGIN]: { PreToolUse: [{ matcher: '*',
      hooks: [{ type: 'command', command, timeout: 30 }] }] } }, null, 2) + '\n');
    return dir;
  } catch (error) { throw new Error('READONLY_GUARD_UNAVAILABLE: ' + String(error)); }
}
