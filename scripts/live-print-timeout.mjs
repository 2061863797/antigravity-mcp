import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

// T6 实验：比较 --print-timeout 0 与正数时，agy 对后台命令的处理。会调用真实模型，须用户授权后手动运行。
// 用法：npm run build 后 ANTIGRAVITY_LIVE_TESTS=1 node scripts/live-print-timeout.mjs [正数期限，默认 60s]
if (process.env.ANTIGRAVITY_LIVE_TESTS !== '1') throw new Error('Real model experiment requires authorization and ANTIGRAVITY_LIVE_TESTS=1.');
const root = fileURLToPath(new URL('../', import.meta.url));
const { buildCliArguments, detectBackgroundAbort } = await import(pathToFileURL(path.join(root, 'dist/agy-executor.js')).href);
const { configManager } = await import(pathToFileURL(path.join(root, 'dist/utils/config-manager.js')).href);
const cli = process.env.AGY_PATH ?? (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe') : 'agy');
const positive = process.argv[2] ?? '60s';
const hardLimitMs = 15 * 60 * 1000;
const cliVersion = (await promisify(execFile)(cli, ['--version'], { windowsHide: true, timeout: 10000 })).stdout.trim();
fs.mkdirSync(path.join(root, 'audit'), { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'audit', 'print-timeout-')), report = { cliVersion, positive, cases: [] };
const config = configManager.getConfig();
const prompt = 'Start this shell command as a BACKGROUND command and do not wait for it to finish: '
  + 'node -e "setTimeout(()=>require(\'fs\').writeFileSync(\'background-done.txt\',\'done\'),90000)". '
  + 'Immediately after starting it, reply with the single word STARTED.';

function runCase(label, printTimeout) {
  const workspace = path.join(directory, label); fs.mkdirSync(workspace, { recursive: true });
  // 与执行器完全相同的参数，只替换 --print-timeout 的值。
  const args = buildCliArguments({ prompt, workspaceDir: workspace, autoApprove: true, mode: 'accept-edits' }, workspace, config.defaultModel, config.defaultEffort);
  args[args.indexOf('--print-timeout') + 1] = printTimeout;
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(cli, args, { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', killed = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    const guard = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, hardLimitMs);
    child.on('close', (exitCode, signal) => {
      clearTimeout(guard);
      let result = null;
      for (const line of stdout.split(/\r?\n/).reverse()) {
        try { const event = JSON.parse(line); if (event.event === 'result') { result = event.result; break; } } catch { /* 非 JSON 行 */ }
      }
      resolve({ label, printTimeout, exitCode, signal, killedByHardLimit: killed, elapsedSeconds: (Date.now() - started) / 1000,
        resultStatus: result?.status ?? null, response: result?.response?.slice(0, 2000) ?? null, resultError: result?.error ?? null,
        backgroundAbortDetected: detectBackgroundAbort(stderr), backgroundFinished: fs.existsSync(path.join(workspace, 'background-done.txt')),
        stderrTail: stderr });
    });
  });
}

try {
  for (const [label, value] of [['zero', '0'], ['positive', positive]]) {
    const outcome = await runCase(label, value);
    report.cases.push(outcome);
    console.log(JSON.stringify({ label, exitCode: outcome.exitCode, resultStatus: outcome.resultStatus,
      elapsedSeconds: outcome.elapsedSeconds, backgroundAbortDetected: outcome.backgroundAbortDetected }));
  }
} finally {
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath: path.join(directory, 'report.json') }));
}
