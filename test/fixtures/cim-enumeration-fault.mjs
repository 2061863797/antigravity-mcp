import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';

const mode = process.argv[2], workspace = process.argv[3], original = cp.execFile;
if (!['missing', 'mismatch'].includes(mode) || !path.isAbsolute(workspace)) throw new Error('Invalid fixture arguments');
fs.mkdirSync(workspace, { recursive: true });
let fault = true, injectedQueries = 0;
const needle = '$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)';
const shim = (executable, args, options, callback) => original(executable, args.map(value => {
  if (!fault || typeof value !== 'string' || !value.includes(needle)) return value;
  injectedQueries++;
  const replacement = mode === 'missing'
    ? '$rows = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne [int]$env:AGY_STOP_PID } | Select-Object ProcessId, ParentProcessId, CreationDate)'
    : needle + '\nforeach ($row in $rows) { if ($row.ProcessId -eq [int]$env:AGY_STOP_PID) { $row.CreationDate = $row.CreationDate.AddMilliseconds(1) } }';
  return value.replace(needle, replacement);
}), options, callback);
shim[promisify.custom] = (executable, args, options) => new Promise((resolve, reject) => {
  shim(executable, args, options, (error, stdout, stderr) => {
    if (error) reject(error); else resolve({ stdout, stderr });
  });
});
cp.execFile = shim; syncBuiltinESMExports();
const { captureCreatedAt } = await import('../../src/utils/process-identity.js');
const { killProcessTree, isProcessAlive } = await import('../../src/utils/process-killer.js');
const { TaskTracker } = await import('../../src/utils/task-tracker.js');
const { acquireWorkspaceLease, updateLeaseChild, releaseWorkspaceLease } = await import('../../src/utils/workspace-lease.js');
const tracker = new TaskTracker(), id = 'cim-' + mode;
const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);setTimeout(()=>process.exit(0),45000)'], { windowsHide: true, stdio: 'ignore' });
let task;
try {
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const stamp = captureCreatedAt(child.pid);
  if (!stamp || !acquireWorkspaceLease(id, workspace)) throw new Error('Fixture identity or lease unavailable');
  task = tracker.create({ taskId: id, workspaceDir: workspace, executionWorkspaceDir: workspace });
  tracker.trackPid(task, child.pid, true, stamp); updateLeaseChild(id, child.pid, true, stamp);
  tracker.update(task, { executionStarted: true, currentPhase: 'CODING' });
  const native = await killProcessTree(child.pid, stamp), aliveAfterNative = await isProcessAlive(child.pid);
  const cancelled = await tracker.cancel(id), report = tracker.report(cancelled);
  const contender = acquireWorkspaceLease('contender', workspace); if (contender) releaseWorkspaceLease('contender');
  const duringFault = { native, aliveAfterNative, cancellationStatus: report.status, errorCode: report.errorCode,
    managedProcess: report.managedProcess, aliveAfterCancel: await isProcessAlive(child.pid), leaseBlocked: !contender, injectedQueries };
  fault = false;
  const recovered = await tracker.cancel(id);
  const successor = acquireWorkspaceLease('successor', workspace); if (successor) releaseWorkspaceLease('successor');
  console.log(JSON.stringify({ mode, duringFault, afterRecovery: { status: recovered.result.status, alive: await isProcessAlive(child.pid), leaseAvailable: successor } }));
} finally {
  fault = false; cp.execFile = original; syncBuiltinESMExports();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  }
  if (task) await tracker.cancel(id);
  releaseWorkspaceLease(id);
}
