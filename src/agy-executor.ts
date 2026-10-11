import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { configManager } from './utils/config-manager.js';
import { canonicalPath, resolveWorkspaceDir, validateWorkspaceSafety, getAgyExecutablePath } from './utils/paths.js';
import { runManagedProcess, formatCommandLine, startWindowsWorker } from './utils/managed-process.js';
import { acquireWorkspaceLease, updateLeaseChild, releaseWorkspaceLease, workspaceLeaseReference, handoffWorkspaceLease, adoptWorkspaceLease } from './utils/workspace-lease.js';
import { taskTracker, type TaskRecord } from './utils/task-tracker.js';
import { sessionManager } from './utils/session-manager.js';
import { CliEventParser } from './utils/cli-events.js';
import { normalizeResult, type TaskResult } from './utils/register-tool.js';
import { logger } from './utils/logger.js';
import { stateHome, taskFile, writeJson, removeTaskInput } from './utils/task-store.js';
import { isQuotaExhaustion } from './utils/native-quota.js';
import { knownCreatedAt, identityState } from './utils/process-identity.js';
import { killProcessTree } from './utils/process-killer.js';
import { ensureAgyVersion } from './utils/agy-version.js';
import { snapshotWorkspace, compareWorkspace } from './utils/workspace-change.js';

export interface AgyExecuteOptions {
  prompt: string; context?: string; workspaceDir: string; model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  analysis?: boolean; mode?: 'plan' | 'accept-edits'; autoApprove?: boolean;
  conversationId?: string; asyncMode?: boolean;
  debugLog?: boolean; requestWaitTimeoutMs?: number; executionTimeoutMs?: number;
  requestSignal?: AbortSignal; onProgress?: (revision: number, message: string) => Promise<void>; progressHeartbeatMs?: number;
  cliPath?: string; cliArgsPrefix?: string[];
}
const InputSchema = z.object({
  prompt: z.string().trim().min(1).max(24000), context: z.string().max(20000).optional(), workspaceDir: z.string().min(1).max(32767).refine(path.isAbsolute),
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).optional(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  analysis: z.boolean().optional(), autoApprove: z.boolean().optional(),
  mode: z.enum(['plan', 'accept-edits']).optional(), conversationId: z.string().min(1).max(256).optional(), asyncMode: z.boolean().optional(),
  debugLog: z.boolean().optional(),
  requestWaitTimeoutMs: z.number().positive().max(86400000).optional(), executionTimeoutMs: z.number().positive().max(86400000).optional(),
  cliPath: z.string().optional(), cliArgsPrefix: z.array(z.string()).optional(),
  requestSignal: z.custom<AbortSignal>().optional(), onProgress: z.custom<AgyExecuteOptions['onProgress']>().optional(),
  progressHeartbeatMs: z.number().int().positive().optional()
}).strict();
const checkAbort = (options: { signal?: AbortSignal; deadlineAt?: number }) => {
  if (options.signal?.aborted) throw new Error(String(options.signal.reason ?? 'CANCELLED'));
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) throw new Error('TIMEOUT');
};
export function buildCliArguments(options: AgyExecuteOptions, workspace: string, model: string, effort: string): string[] {
  const instruction = options.mode === 'plan' ? 'Produce the requested plan; do not apply implementation changes.'
    : options.analysis ? 'Analyze only; do not modify files. Deliver the requested answer, investigation or review findings, rather than an implementation plan unless explicitly requested.'
      : 'Complete only the requested edits.';
  const prompt = [options.prompt, options.context ? 'Context:\n' + options.context : '',
    'Execution workspace: ' + workspace + '. ' + instruction].filter(Boolean).join('\n\n');
  const args = [...options.cliArgsPrefix ?? [], '-p', prompt, '--output-format', 'stream-json', '--print-timeout', '0',
    '--add-dir', workspace, '--model', model, '--effort', effort, '--mode', options.mode ?? 'accept-edits', '--sandbox'];
  if (options.autoApprove) args.push('--dangerously-skip-permissions');
  // 普通委派保留提示原文；明确选择 plan 时保留 CLI 的规划指令展开。
  if (options.mode !== 'plan') args.push('--disable-slash-commands');
  if (options.conversationId) args.push('--conversation', options.conversationId);
  return args;
}
export function validateCommandLine(executable: string, args: string[], platform = process.platform): void {
  if ([executable, ...args].some(value => value.includes('\0'))) throw new Error('INVALID_ARGUMENT: NUL characters are not supported');
  if (platform === 'win32' && formatCommandLine(executable, args).length > 30000) throw new Error('INPUT_TOO_LARGE: escaped Windows command line exceeds 30000 characters');
}
// agy 无头空闲时会等待并在退出时终止后台任务，退出码仍为 0。两类行同时出现才判定，偏向精确。
export function detectBackgroundAbort(stderr: string): boolean {
  const lines = stderr.toLowerCase().split(/\r?\n/);
  return lines.some(line => line.includes('idle') && line.includes('background task'))
    && lines.some(line => line.includes('terminating') && line.includes('background task') && line.includes('on exit'));
}
const failureCode = (error: unknown) => /^(?:[A-Z][A-Z_]+)(?=:|$)/.exec(String(error instanceof Error ? error.message : error))?.[0] ?? 'EXECUTION_FAILED';
// 同步等待期间按此间隔重复发送当前阶段，使有空闲超时的客户端看到任务仍在运行。
export const PROGRESS_HEARTBEAT_MS = 60000;
function requestProgress(options: AgyExecuteOptions): (result: TaskResult, heartbeat?: boolean) => Promise<void> {
  let previous: string | undefined, sequence = -1, pending = Promise.resolve();
  return (result, heartbeat = false) => {
    const stage = result.status === 'RUNNING' ? result.currentPhase : result.status;
    if (!options.onProgress || options.asyncMode || previous === stage && !heartbeat) return pending;
    previous = stage; sequence = Math.max(sequence + 1, result.revision);
    const value = sequence;
    const elapsed = heartbeat && result.elapsedSeconds !== null ? Math.floor(result.elapsedSeconds) + 's' : null;
    const message = [stage, result.taskId, elapsed, result.activeTool, result.activeFile ?? result.recentCommand,
      result.errorCode].filter(Boolean).join(': ').slice(0, 512).replace(/[\uD800-\uDBFF]$/, '');
    pending = pending.then(() => options.onProgress!(value, message)).catch(error => logger.warn('Progress notification failed:', error));
    return pending;
  };
}

async function launchWorker(task: TaskRecord, input: AgyExecuteOptions): Promise<void> {
  const workerFile = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './task-worker.ts' : './task-worker.js', import.meta.url));
  if (!fs.existsSync(workerFile)) throw new Error('WORKER_START_FAILED: worker entrypoint is missing; build the package first');
  const runtime = workerFile.endsWith('.ts') ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
  const { requestSignal: _signal, onProgress: _progress, ...serializable } = input;
  writeJson(taskFile(task.result.taskId!, 'launch'), { token: task.token, options: { ...serializable, asyncMode: true } });
  const env = { ...process.env, ANTIGRAVITY_MCP_STATE_HOME: stateHome() };
  let child: ReturnType<typeof spawn> | undefined, pid: number | undefined;
  let error: Error | undefined;
  let handedOff = false;
  let diagnostic = '';
  try {
    if (process.platform === 'win32') pid = await startWindowsWorker(process.execPath, [...runtime, workerFile, task.result.taskId!], path.dirname(workerFile), env);
    else {
      child = spawn(process.execPath, [...runtime, workerFile, task.result.taskId!], {
        cwd: path.dirname(workerFile), detached: true, stdio: ['ignore', 'ignore', 'pipe'], env
      });
      child.stderr?.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-8192); });
      child.on('error', failure => { error = failure; }); child.unref(); pid = child.pid;
    }
    if (!pid) { await new Promise(resolve => setTimeout(resolve, 10)); throw error ?? new Error('worker has no PID'); }
    task.workerPid = pid; task.ownerPid = pid; task.workerCreatedAt = knownCreatedAt(pid); task.ownerCreatedAt = task.workerCreatedAt; task.remote = true;
    taskTracker.persist(task, true); handoffWorkspaceLease(task.result.taskId!, pid, task.workerCreatedAt); handedOff = true;
    const requestDeadline = input.asyncMode || input.requestWaitTimeoutMs === undefined ? Infinity : task.startedAt + input.requestWaitTimeoutMs;
    const end = Math.min(Date.now() + 10000, requestDeadline);
    while (Date.now() < end) {
      const observed = taskTracker.get(task.result.taskId!);
      if (observed?.ready) return;
      if (observed?.result.status !== 'RUNNING' || error || identityState(pid, task.workerCreatedAt, observed?.heartbeatAt) === 'EXITED') {
        await new Promise(resolve => setTimeout(resolve, 10));
        throw error ?? new Error(diagnostic || 'worker exited during initialization');
      }
      await new Promise(resolve => setTimeout(resolve, 20));
      if (input.requestSignal?.aborted) break;
    }
    // 已接受任务继续由 worker 管理；初始化慢只影响当前等待，不重新执行。
  } catch (failure) {
    if (!handedOff && pid && identityState(pid, task.workerCreatedAt) !== 'EXITED') {
      if (child) child.kill('SIGKILL'); else if (task.workerCreatedAt) await killProcessTree(pid, task.workerCreatedAt);
      const until = Date.now() + 3000;
      while (identityState(pid, task.workerCreatedAt) !== 'EXITED' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      if (identityState(pid, task.workerCreatedAt) === 'EXITED') releaseWorkspaceLease(task.result.taskId!);
    }
    if (pid && identityState(pid, task.workerCreatedAt) !== 'EXITED') throw failure;
    removeTaskInput(task.result.taskId!);
    throw new Error('WORKER_START_FAILED: ' + String(failure));
  } finally { child?.stderr?.destroy(); }
}

export async function executeAgy(input: AgyExecuteOptions, workerTaskId?: string): Promise<TaskResult> {
  const taskId = workerTaskId ?? 'task_' + Date.now() + '_' + crypto.randomUUID().slice(0, 8);
  const prepared = prepareExecution(input);
  if ('schemaVersion' in prepared) return prepared;
  const task = await claimTask(prepared, taskId, workerTaskId);
  if ('schemaVersion' in task) return task;
  return workerTaskId ? runTask(task, prepared) : submitTask(task, prepared);
}

interface PreparedExecution {
  options: AgyExecuteOptions; source: string; workspace: string; model: string; effort: string; args: string[]; executable: string;
}
// 阶段一：校验输入、解析会话与目录、确定模型和命令行；失败时不创建任务。
function prepareExecution(input: AgyExecuteOptions): PreparedExecution | TaskResult {
  let options: AgyExecuteOptions, source: string, workspace: string, model: string, effort: string, args: string[], executable: string;
  const failureStage: NonNullable<TaskResult['failureStage']> = 'INPUT';
  try {
    options = { ...input, ...InputSchema.parse(input) };
    if (options.requestSignal?.aborted) throw new Error('CANCELLED');
    source = options.conversationId ? canonicalPath(options.workspaceDir) : resolveWorkspaceDir(options.workspaceDir);
    const session = options.conversationId ? sessionManager.resolve(options.conversationId, source) : undefined;
    workspace = session?.workspaceDir ?? source;
    const safety = validateWorkspaceSafety(source); if (!safety.safe) throw new Error('INVALID_ARGUMENT: ' + safety.reason);
    const config = configManager.getConfig(); model = options.model ?? session?.model ?? config.defaultModel; effort = options.effort ?? session?.effort ?? config.defaultEffort;
    options.autoApprove ??= config.defaultAutoApprove ?? true;
    const executionSafety = validateWorkspaceSafety(workspace); if (!executionSafety.safe) throw new Error('INVALID_ARGUMENT: ' + executionSafety.reason);
    executable = options.cliPath ?? getAgyExecutablePath(); args = buildCliArguments(options, workspace, model, effort);
    validateCommandLine(executable, args);
  } catch (error) {
    const code = error instanceof z.ZodError ? 'INVALID_ARGUMENT' : failureCode(error);
    return normalizeResult({ status: code === 'CANCELLED' ? 'CANCELLED' : 'ERROR', executionStatus: code, errorCode: code,
      errorMessage: String(error), failureStage, response: String(error), workspaceDir: input.workspaceDir ?? null, conversationId: input.conversationId ?? null });
  }
  return { options, source, workspace, model, effort, args, executable };
}

// 阶段二：提交方先做版本预检再获取租约并登记任务；worker 接管已登记任务的租约。
async function claimTask({ options, source, workspace, model, effort, executable }: PreparedExecution, taskId: string,
  workerTaskId?: string): Promise<TaskRecord | TaskResult> {
  const failureStage: NonNullable<TaskResult['failureStage']> = 'PREPARING';
  let leased = false, task: TaskRecord;
  try {
    // 提交方在获取租约前完成预检；worker 继续使用已经通过预检的同一命令。
    if (!workerTaskId) {
      await ensureAgyVersion(executable, options.cliArgsPrefix, { cwd: workspace, signal: options.requestSignal });
      if (options.requestSignal?.aborted) throw new Error('CANCELLED');
    }
    if (workerTaskId) {
      task = taskTracker.get(taskId)!;
      if (!task?.lease) throw new Error('WORKER_BINDING_INVALID');
      adoptWorkspaceLease(taskId, workspace, task.lease); leased = true; task = taskTracker.attachLocal(taskId);
    } else {
      const posixJobToken = process.platform === 'linux' ? crypto.randomUUID() : undefined;
      leased = acquireWorkspaceLease(taskId, workspace, posixJobToken);
      if (!leased) throw new Error('WORKSPACE_BUSY: another task owns this execution directory');
      task = taskTracker.create({ taskId, workspaceDir: source, executionWorkspaceDir: workspace, model, effort,
        cliMode: options.mode ?? 'accept-edits', autoApprove: options.autoApprove ?? true, conversationId: options.conversationId ?? null }, posixJobToken);
      task.lease = workspaceLeaseReference(taskId);
      task.result.deadlineAt = options.executionTimeoutMs === undefined ? null : new Date(task.startedAt + options.executionTimeoutMs).toISOString();
      taskTracker.persist(task, true);
    }
  } catch (error) {
    if (leased) releaseWorkspaceLease(taskId);
    const code = failureCode(error);
    return normalizeResult({ status: code === 'CANCELLED' ? 'CANCELLED' : 'ERROR', executionStatus: code, errorCode: code, errorMessage: String(error), failureStage,
      response: String(error), workspaceDir: source, executionWorkspaceDir: workspace, conversationId: options.conversationId ?? null });
  }
  return task;
}

// 阶段三（提交方）：启动独立 worker，按请求方式返回任务 ID 或等待结果。
async function submitTask(task: TaskRecord, { options, model, effort, executable }: PreparedExecution): Promise<TaskResult> {
  const taskId = task.result.taskId!;
  const notifyProgress = requestProgress(options);
  await notifyProgress(task.result);
  try { await launchWorker(task, { ...options, model, effort: effort as AgyExecuteOptions['effort'], cliPath: executable }); }
  catch (error) {
    if (task.workerPid && identityState(task.workerPid, task.workerCreatedAt) !== 'EXITED') {
      task.result.errorCode = 'WORKER_START_UNCONFIRMED'; task.result.errorMessage = String(error);
      await notifyProgress(task.result);
      return taskTracker.report(task);
    }
    releaseWorkspaceLease(taskId);
    const code = failureCode(error); taskTracker.update(task, { status: 'ERROR', executionStatus: code, errorCode: code,
      errorMessage: String(error), stderrTail: String(error).slice(-8192), failureStage: 'PREPARING' }); taskTracker.persist(task, true);
    await notifyProgress(task.result);
    return taskTracker.report(task);
  }
  return waitForTask(task, options, notifyProgress);
}

// 阶段三（worker）：运行 agy、解析事件流、判定结果并在确认停止后释放租约。
function runTask(task: TaskRecord, { options, workspace, model, effort, args, executable }: PreparedExecution): Promise<TaskResult> | TaskResult {
  const taskId = task.result.taskId!;
  let failureStage: NonNullable<TaskResult['failureStage']> = 'PREPARING';
  const deadlineAt = options.executionTimeoutMs === undefined ? undefined : task.startedAt + options.executionTimeoutMs;
  const deadlineTimer = deadlineAt === undefined ? undefined : setTimeout(() => task.abortController!.abort('TIMEOUT'), Math.max(1, deadlineAt - Date.now()));
  const active = { signal: task.abortController!.signal, deadlineAt };
  const stopping = () => taskTracker.update(task, { currentPhase: 'STOPPING' });
  active.signal.addEventListener('abort', stopping, { once: true });
  const track = (pid: number, add: boolean, createdAt?: string) => { taskTracker.trackPid(task, pid, add, createdAt); updateLeaseChild(taskId, pid, add, createdAt); };
  const execution = (async (): Promise<void> => {
    let stopped = true;
    let outcome: Partial<TaskResult> & { status: Exclude<TaskResult['status'], 'RUNNING'> } | undefined;
    try {
      taskTracker.update(task, { deadlineAt: deadlineAt === undefined ? null : new Date(deadlineAt).toISOString() });
      checkAbort(active);
      const maxBytes = 5 * 1024 * 1024;
      const marker = Buffer.from('\nRAW_STDOUT_LOG_TRUNCATED: log size limit reached; event parsing continued.\n');
      const rawLog = options.debugLog ? { path: path.join(stateHome(), '.gemini', 'antigravity-mcp-logs', taskId + '.log'), maxBytes, writtenBytes: 0, truncated: false } : null;
      let logFd: number | undefined;
      if (rawLog) { fs.mkdirSync(path.dirname(rawLog.path), { recursive: true }); logFd = fs.openSync(rawLog.path, 'wx'); }
      let registeredConversation: string | undefined, responseStep: string | undefined, streamFailure: unknown;
      const registerConversation = (id: string) => {
        if (options.conversationId && id !== options.conversationId) throw new Error('CLI_OUTPUT_INVALID: CLI changed the requested conversation ID');
        if (registeredConversation === id) return;
        sessionManager.save(id, workspace, taskId, { model, effort: effort as AgyExecuteOptions['effort'] });
        taskTracker.update(task, { conversationId: id }); taskTracker.persist(task, true); registeredConversation = id;
      };
      const parser = new CliEventParser(event => {
        try {
          if (event.conversationId) registerConversation(event.conversationId);
          const tool = event.kind.startsWith('tool_');
          let currentPhase = task.result.currentPhase;
          if (currentPhase !== 'STOPPING') {
            if (event.kind === 'tool_start' && ['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'notebook_edit'].includes(event.tool ?? '')) currentPhase = 'CODING';
            else if (currentPhase === 'PREPARING' && (event.kind === 'initialization' || event.kind === 'response' || tool)) currentPhase = 'ANALYZING';
          }
          let recentTools = task.result.recentTools, latestText = task.result.latestText;
          if (tool && event.stepId) {
            const previous = recentTools.find(item => item.stepId === event.stepId);
            const operation: TaskResult['recentTools'][number] = { stepId: event.stepId, stepIndex: event.stepIndex ?? null,
              tool: event.tool ?? previous?.tool ?? null, file: event.file ?? previous?.file ?? null,
              command: event.command?.slice(0, 2048) ?? previous?.command ?? null,
              state: event.kind === 'tool_end' ? 'DONE' : 'ACTIVE', success: event.success ?? previous?.success ?? null };
            recentTools = previous ? recentTools.map(item => item.stepId === event.stepId ? operation : item) : [...recentTools, operation].slice(-5);
          }
          if (event.kind === 'response') {
            if (responseStep !== event.stepId) { latestText = ''; responseStep = event.stepId; }
            latestText = (latestText + (event.textDelta ?? '')).slice(-4000);
            // 避免展示上限把 emoji 的 UTF-16 代理对截成半个字符。
            if (/^[\uDC00-\uDFFF]/.test(latestText)) latestText = latestText.slice(1);
          }
          const currentTool = recentTools.filter(item => item.state === 'ACTIVE').at(-1);
          taskTracker.update(task, { currentPhase,
            recentTools, latestText,
            ...(event.permissionMode ? { cliPermissionMode: event.permissionMode } : {}),
            activeTool: tool ? currentTool?.tool ?? null : task.result.activeTool,
            activeFile: tool ? currentTool?.file ?? null : task.result.activeFile,
            recentCommand: tool ? currentTool?.command ?? null : task.result.recentCommand,
            ...(tool ? { lastActivity: { phase: currentPhase, tool: event.tool ?? null,
              file: event.file ?? null, command: event.command?.slice(0, 2048) ?? null } } : {}) }, tool);
        } catch (error) { streamFailure = error; throw error; }
      });
      taskTracker.update(task, { rawLog });
      const workspaceBefore = options.analysis ? snapshotWorkspace(workspace) : undefined;
      failureStage = 'CLI';
      stopped = false;
      let output: Awaited<ReturnType<typeof runManagedProcess>>;
      try {
        output = await runManagedProcess(executable, args, { cwd: workspace, signal: active.signal, streamingOutput: true, jobToken: task.posixJobToken,
          onSpawn: (pid, createdAt) => { track(pid, true, createdAt); taskTracker.update(task, { executionStarted: true }); },
          onExit: pid => track(pid, false), onOutput: () => taskTracker.output(task),
          onStdoutChunk: chunk => {
            if (rawLog && logFd !== undefined) {
              const remaining = Math.max(0, maxBytes - marker.length - rawLog.writtenBytes);
              if (remaining > 0) rawLog.writtenBytes += fs.writeSync(logFd, chunk.subarray(0, remaining));
              if (chunk.length > remaining && !rawLog.truncated) { rawLog.writtenBytes += fs.writeSync(logFd, marker); rawLog.truncated = true; }
            }
            parser.push(chunk);
          } });
      } finally { if (logFd !== undefined) fs.closeSync(logFd); }
      stopped = output.stopped;
      taskTracker.update(task, { processExitCode: output.exitCode, stderrTail: output.stderr.slice(-8192),
        ...compareWorkspace(workspaceBefore, workspaceBefore && snapshotWorkspace(workspace)) });
      if (!stopped) throw new Error('PROCESS_TERMINATION_UNCONFIRMED');
      if (streamFailure) throw streamFailure;
      failureStage = 'RESULT';
      const envelope = parser.finish();
      taskTracker.update(task, { rawLog, response: envelope?.response ?? '', cliStatus: envelope?.status ?? null,
        conversationId: envelope?.conversation_id ?? task.result.conversationId, cliError: envelope?.error ?? parser.protocolError ?? output.error ?? (output.exitCode !== 0 ? output.stderr || null : null),
        usage: envelope?.usage ?? null, usageScope: envelope?.usageScope ?? 'unknown', upstreamDurationSeconds: envelope?.duration_seconds ?? null });
      if (envelope?.conversation_id) registerConversation(envelope.conversation_id);
      failureStage = 'CLI';
      checkAbort(active);
      if (output.error) throw new Error(output.error);
      if (!envelope) {
        if (!parser.protocolError && output.exitCode !== 0) throw new Error('CLI_EXIT_FAILED: ' + (output.stderr.trim() || String(output.exitCode)));
        failureStage = 'RESULT'; throw new Error('CLI_OUTPUT_INVALID: ' + (parser.protocolError ?? 'No valid final result'));
      }
      if (envelope.status !== 'SUCCESS') {
        const code = envelope.status === 'CANCELED' || envelope.status === 'CANCELLED' ? 'CANCELLED'
          : envelope.status === 'RUNNING' ? 'CLI_INCOMPLETE' : envelope.status === 'ERROR' ? 'CLI_ERROR' : 'CLI_' + envelope.status;
        const detail = envelope.error?.trim() || 'CLI returned ' + envelope.status;
        throw new Error(code + ': ' + detail);
      }
      if (envelope.error?.trim()) throw new Error('CLI_ERROR: ' + envelope.error);
      if (output.exitCode !== 0) throw new Error('CLI_EXIT_FAILED: ' + output.exitCode);
      if (detectBackgroundAbort(output.stderr)) throw new Error('CLI_BACKGROUND_ABORTED: agy 退出时终止了仍在运行的后台任务；response 只是部分结果，不代表任务完成。');
      checkAbort(active);
      outcome = { status: 'SUCCESS', executionStatus: 'SUCCESS', errorCode: null };
    } catch (error) {
      const aborted = task.abortController!.signal.aborted;
      let code = !stopped ? 'PROCESS_TERMINATION_UNCONFIRMED' : aborted ? String(task.abortController!.signal.reason) : failureCode(error);
      if (['CLI_ERROR', 'CLI_EXIT_FAILED'].includes(code)
          && [task.result.cliError, task.result.stderrTail, String(error)].some(message => message && isQuotaExhaustion(message))) {
        code = 'CLI_QUOTA_EXHAUSTED';
      }
      if (code === 'TIMEOUT' && !aborted) task.abortController!.abort('TIMEOUT');
      if (code === 'PROCESS_TERMINATION_UNCONFIRMED') taskTracker.update(task, {
        executionStatus: code, errorCode: code, failureStage, errorMessage: String(error), nextAction: null, currentPhase: 'STOPPING', response: task.result.response || String(error) });
      else outcome = { status: code === 'TIMEOUT' ? 'TIMEOUT' : code === 'CANCELLED' ? 'CANCELLED' : 'ERROR',
        executionStatus: code, errorCode: code, failureStage, errorMessage: String(error), response: task.result.response || String(error) };
    } finally {
      clearTimeout(deadlineTimer);
      active.signal.removeEventListener('abort', stopping);
      if (stopped) releaseWorkspaceLease(taskId);
    }
    if (outcome) taskTracker.finish(task, outcome);
  })().catch(error => {
    const data: Partial<TaskResult> = { status: 'RUNNING', executionStatus: failureCode(error), errorCode: failureCode(error),
      failureStage: 'STOPPING', errorMessage: String(error), nextAction: '继续查询并重试取消；目录占用释放前，不重新提交。', currentPhase: 'STOPPING', response: String(error) };
    try { taskTracker.update(task, data); } catch { Object.assign(task.result, data); }
    logger.error('Task cleanup requires a cancellation retry:', error);
  });
  task.completion = execution;
  return waitForTask(task, options);
}
function waitForTask(task: TaskRecord, options: AgyExecuteOptions, notifyProgress = requestProgress(options)): Promise<TaskResult> | TaskResult {  const taskId = task.result.taskId!;
  if (options.asyncMode) return taskTracker.report(task);
  return new Promise<TaskResult>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return; settled = true; clearTimeout(waitTimer); clearInterval(heartbeat); unsubscribe();
      options.requestSignal?.removeEventListener('abort', finish);
      const result = taskTracker.report(task);
      void notifyProgress(result).then(() => resolve(result));
    };
    const unsubscribe = taskTracker.subscribe(taskId, () => {
      if (settled) return;
      void notifyProgress(task.result);
      if (task.result.status !== 'RUNNING' || task.result.errorCode && task.result.currentPhase === 'STOPPING') { finish(); return; }
    });
    const waitTimer = options.requestWaitTimeoutMs === undefined ? undefined
      : setTimeout(finish, Math.max(1, options.requestWaitTimeoutMs - (Date.now() - task.startedAt)));
    const heartbeat = options.onProgress ? setInterval(() => {
      if (!settled && task.result.status === 'RUNNING') void notifyProgress(taskTracker.report(task), true);
    }, options.progressHeartbeatMs ?? PROGRESS_HEARTBEAT_MS) : undefined;
    options.requestSignal?.addEventListener('abort', finish, { once: true });
    task.completion?.then(finish, finish);
    void notifyProgress(task.result);
    if (options.requestSignal?.aborted || taskTracker.get(taskId)?.result.status !== 'RUNNING') finish();
  });
}
