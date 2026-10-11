import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { captureCreatedAt, identityState } from '../src/utils/process-identity.js';

const original = childProcess.execFile;
let commandFailure: Error | undefined, commandCalls = 0, disableAutoload = false;
const shim = () => { throw new Error('Expected the promisified stop call'); };
Object.defineProperty(shim, promisify.custom, { value: (file: string, args: string[], options: childProcess.ExecFileOptions) => {
  if (!commandFailure) return promisify(original)(file, disableAutoload
    ? [...args.slice(0, -1), "$PSModuleAutoLoadingPreference = 'None'\n" + args.at(-1)] : args, options);
  commandCalls++;
  assert.equal(options.timeout, 10000); assert.equal(options.windowsHide, true);
  throw commandFailure;
} });
childProcess.execFile = shim as unknown as typeof original;
syncBuiltinESMExports();
const { killProcessTree } = await import('../src/utils/process-killer.js');
childProcess.execFile = original;
syncBuiltinESMExports();

async function withChild(action: (pid: number, createdAt: string) => Promise<void>) {
  const child = childProcess.spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const createdAt = captureCreatedAt(child.pid!); assert(createdAt);
    await action(child.pid!, createdAt);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
    }
  }
}
const windowsOnly = { skip: process.platform !== 'win32' ? '需要 Windows 原生进程身份与停止路径' : false };

test('identity read diagnostics preserve UNKNOWN and do not retry or change the deadline', windowsOnly, async () => {
  await withChild(async (pid, createdAt) => {
    const execSync = childProcess.execFileSync, messages: string[] = []; let calls = 0;
    childProcess.execFileSync = ((_file: string, _args: string[], options: childProcess.ExecFileSyncOptions) => {
      calls++; assert.equal(options.timeout, 5000); assert.equal(options.windowsHide, true);
      throw new Error('injected identity timeout');
    }) as unknown as typeof execSync;
    try {
      assert.equal(identityState(pid, createdAt, undefined, true, message => messages.push(message)), 'UNKNOWN');
      assert.equal(calls, 1); assert(messages.some(message => message.includes('injected identity timeout')));
      assert.doesNotThrow(() => process.kill(pid, 0));
    } finally { childProcess.execFileSync = execSync; }
    assert.equal(identityState(pid, createdAt, undefined, true), 'ALIVE');
  });
});

test('Windows stop command diagnostics preserve unconfirmed termination and retain the failed stage', windowsOnly, async () => {
  await withChild(async (pid, createdAt) => {
    const messages: string[] = [];
    commandFailure = new Error('injected timeout: AGY_MCP_STOP_STAGE=CIM_ENUMERATION'); commandCalls = 0;
    try {
      assert.deepEqual(await killProcessTree(pid, createdAt, undefined, { onDiagnostic: message => messages.push(message) }),
        { success: false, verifiedTerminated: false });
      assert.equal(commandCalls, 1); assert(messages.some(message => message.includes('AGY_MCP_STOP_STAGE=CIM_ENUMERATION')));
      assert.doesNotThrow(() => process.kill(pid, 0));
    } finally { commandFailure = undefined; }
  });
});

test('Windows tree termination verifies the original process without module autoload', windowsOnly, async () => {
  await withChild(async (pid, createdAt) => {
    const messages: string[] = []; disableAutoload = true;
    try {
      assert.deepEqual(await killProcessTree(pid, createdAt, undefined, { onDiagnostic: message => messages.push(message) }),
        { success: true, verifiedTerminated: true });
      assert.equal(identityState(pid, createdAt, undefined, true), 'EXITED');
      assert(messages.some(message => message.includes('AGY_MCP_STOP_STAGE=COMPLETE;VERIFIED=True')));
    } finally { disableAutoload = false; }
  });
});
