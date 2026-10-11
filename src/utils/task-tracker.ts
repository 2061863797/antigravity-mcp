import { addFailureDetails, normalizeResult, type TaskResult } from './register-tool.js';
import { killProcessTree, findPidsByEnvTokenSync } from './process-killer.js';
import { releaseWorkspaceLease } from './workspace-lease.js';
import { logger } from './logger.js';
import crypto from 'node:crypto';
import { saveTask, readTask, taskStamp, pruneTasks, requestCancellation, removeTaskInput, type StoredTask } from './task-store.js';
import { identityState, requireSelfIdentity } from './process-identity.js';

export interface TaskRecord extends StoredTask {
  abortController?: AbortController; completion?: Promise<void>; cancellation?: Promise<void>;
  remote?: boolean; persistTimer?: ReturnType<typeof setTimeout>;
}
export class TaskTracker {
  private tasks = new Map<string, TaskRecord>();
  private listeners = new Map<string, Set<() => void>>();
  private watchers = new Map<string, ReturnType<typeof setInterval>>();
  private stamps = new Map<string, string>();
  public create(data: Partial<TaskResult> & { taskId: string; workspaceDir: string }, posixJobToken?: string): TaskRecord {
    if (this.get(data.taskId)) throw new Error('TASK_ALREADY_EXISTS');
    const startedAt = Date.now();
    const task: TaskRecord = { result: normalizeResult({ ...data, status: 'RUNNING', executionStatus: 'RUNNING', currentPhase: 'PREPARING',
      startedAt: new Date(startedAt).toISOString(), lastObservedAt: new Date(startedAt).toISOString() }),
      version: 1, startedAt, childPids: [], ownerPid: process.pid, workerPid: null,
      ownerCreatedAt: requireSelfIdentity(), childCreatedAt: {},
      token: crypto.randomUUID(), posixJobToken, ready: false, heartbeatAt: startedAt, lease: null, abortController: new AbortController() };
    this.persist(task, true); this.tasks.set(data.taskId, task); this.prune();
    return task;
  }
  public get(id: string): TaskRecord | undefined {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('INVALID_TASK_ID');
    let task = this.tasks.get(id);
    if (!task || task.remote) {
      // 远端记录未变化时跳过重复的读取和校验；进程身份仍在下方每次核对。
      const stamp = taskStamp(id);
      const revision = task?.result.revision;
      if (!task || stamp === undefined || this.stamps.get(id) !== stamp) {
        const stored = readTask(id);
        if (!stored) { this.tasks.delete(id); this.stamps.delete(id); return undefined; }
        if (task) Object.assign(task, stored); else { task = { ...stored, remote: true }; this.tasks.set(id, task); }
        if (stamp === undefined) this.stamps.delete(id); else this.stamps.set(id, stamp);
      }
      if (task.result.status === 'RUNNING' && identityState(task.ownerPid, task.ownerCreatedAt, task.heartbeatAt) === 'EXITED') {
        const pending = task.childPids.some(pid => identityState(pid, task!.childCreatedAt?.[pid]) !== 'EXITED') || this.hasEscapedProcesses(task);
        const code = pending ? 'PROCESS_TERMINATION_UNCONFIRMED' : 'WORKER_INTERRUPTED';
        if (task.result.executionStatus !== code) {
          task.result = addFailureDetails({ ...task.result, status: pending ? 'RUNNING' : 'ERROR', executionStatus: code, errorCode: code,
            failureStage: this.failureStage(task.result.currentPhase) ?? 'CLI',
            revision: task.result.revision + 1, managedProcess: pending ? 'UNKNOWN' : 'EXITED', currentPhase: pending ? 'STOPPING' : 'IDLE',
            errorMessage: '任务执行进程已退出；已有文件、会话和结果片段保留。', nextAction: null,
            lastActivity: task.result.lastActivity ?? this.activity(task.result), activeTool: null, activeFile: null, recentCommand: null });
          this.persist(task, true);
          if (!pending) removeTaskInput(id);
        }
      }
      if (revision !== undefined && revision !== task.result.revision) this.notify(task);
    }
    return task;
  }
  public attachLocal(id: string): TaskRecord {
    const task = this.get(id);
    if (!task || task.workerPid !== process.pid || identityState(process.pid, task.workerCreatedAt) !== 'ALIVE') throw new Error('WORKER_BINDING_INVALID');
    task.remote = false; task.ready = true; task.abortController = new AbortController(); this.persist(task, true);
    return task;
  }
  public persist(task: TaskRecord, immediate = false): void {
    const write = () => {
      task.persistTimer = undefined;
      saveTask({ version: 1, result: task.result, startedAt: task.startedAt, childPids: task.childPids,
        ownerPid: task.ownerPid, workerPid: task.workerPid, token: task.token, ready: task.ready,
        ownerCreatedAt: task.ownerCreatedAt, workerCreatedAt: task.workerCreatedAt, childCreatedAt: task.childCreatedAt, posixJobToken: task.posixJobToken,
        heartbeatAt: task.heartbeatAt, lease: task.lease });
    };
    if (immediate) { clearTimeout(task.persistTimer); write(); }
    else if (!task.persistTimer) task.persistTimer = setTimeout(() => {
      try { write(); } catch (error) { logger.error('Task persistence failed:', error); task.abortController?.abort('TASK_SAVE_FAILED'); }
    }, 100);
  }
  public heartbeat(task: TaskRecord): void {
    if (task.result.status === 'RUNNING') {
      task.heartbeatAt = Date.now(); Object.assign(task.result, this.observed(task)); this.persist(task, true);
    }
  }
  private notify(task: TaskRecord): void {
    for (const listener of this.listeners.get(task.result.taskId!) ?? []) {
      try { listener(); } catch (error) { logger.warn('Progress subscriber failed:', error); }
    }
  }
  private prune(): void {
    // 活动任务不能淘汰；完成任务按创建顺序限制缓存，总量通常不超过 100。
    if (this.tasks.size > 100) for (const [id, task] of this.tasks) {
      if (task.result.status !== 'RUNNING') { this.tasks.delete(id); this.stamps.delete(id); }
      if (this.tasks.size <= 100) break;
    }
  }
  private failureStage(phase: TaskResult['currentPhase']): TaskResult['failureStage'] {
    return phase === 'PREPARING' || phase === 'STOPPING' ? phase : phase === 'CODING' || phase === 'ANALYZING' ? 'CLI' : null;
  }
  private activity(result: TaskResult): TaskResult['lastActivity'] {
    return { phase: result.currentPhase, tool: result.activeTool, file: result.activeFile, command: result.recentCommand };
  }
  private observed(task: TaskRecord): Partial<TaskResult> {
    return { elapsedSeconds: Math.max(task.result.elapsedSeconds ?? 0, (Date.now() - task.startedAt) / 1000),
      lastObservedAt: new Date().toISOString() };
  }
  public update(task: TaskRecord, data: Partial<TaskResult>, effective = false): void {
    const result = addFailureDetails({ ...task.result, ...data, ...(task.result.status === 'RUNNING' ? this.observed(task) : {}),
      revision: task.result.revision + 1 });
    if (effective) result.lastProgressAt = new Date().toISOString();
    task.result = result;
    this.persist(task); this.notify(task);
  }
  public output(task: TaskRecord): void {
    task.result.lastOutputAt = new Date().toISOString();
    // 原始输出只更新时间；工具操作和模型文字由事件解析器提供。
  }
  public trackPid(task: TaskRecord, pid: number, add: boolean, createdAt?: string): void {
    task.childPids = add ? [...new Set([...task.childPids, pid])] : task.childPids.filter(value => value !== pid);
    if (add && createdAt) (task.childCreatedAt ??= {})[pid] = createdAt;
    if (!add && task.childCreatedAt) delete task.childCreatedAt[pid];
    this.update(task, {});
  }
  public report(task: TaskRecord, unchanged = false): TaskResult {
    const owner = task.result.status === 'RUNNING' ? identityState(task.ownerPid, task.ownerCreatedAt, task.heartbeatAt) : 'EXITED';
    const running = task.result.status === 'RUNNING' && owner === 'ALIVE';
    const children = task.childPids.map(pid => identityState(pid, task.childCreatedAt?.[pid], running ? task.heartbeatAt : undefined));
    const unknown = owner === 'UNKNOWN' || children.includes('UNKNOWN');
    return addFailureDetails({ ...task.result, ...(running ? this.observed(task) : {}), unchanged,
      response: unchanged || running && !task.result.errorCode ? '' : task.result.response,
      recentTools: unchanged ? [] : task.result.recentTools, latestText: unchanged ? '' : task.result.latestText,
      ...(owner === 'UNKNOWN' && !task.result.errorCode ? { executionStatus: 'PROCESS_TERMINATION_UNCONFIRMED', errorCode: 'PROCESS_TERMINATION_UNCONFIRMED',
        errorMessage: '无法核对原 worker 的进程身份；会话、文件和任务记录保留。', failureStage: 'STOPPING' as const, nextAction: null } : {}),
      managedProcess: unknown || task.result.executionStatus === 'PROCESS_TERMINATION_UNCONFIRMED' ? 'UNKNOWN'
        : children.includes('ALIVE') ? 'ALIVE' : task.result.executionStarted ? 'EXITED' : 'NOT_STARTED' });
  }
  public finish(task: TaskRecord, data: Partial<TaskResult> & { status: Exclude<TaskResult['status'], 'RUNNING'> }): void {
    if (task.result.status !== 'RUNNING') return;
    this.update(task, { ...data, failureStage: data.errorCode ? data.failureStage ?? task.result.failureStage ?? this.failureStage(task.result.currentPhase) : null,
        errorMessage: data.errorMessage ?? data.errorCode ?? null, nextAction: null, lastActivity: task.result.lastActivity ?? this.activity(task.result),
      currentPhase: 'IDLE', activeTool: null, activeFile: null, recentCommand: null }, true);
    this.persist(task, true);
    try { pruneTasks(); } catch (error) { logger.warn('Completed task cleanup failed:', error); }
    this.prune();
  }
  private escapedPids(task: TaskRecord): number[] {
    if (process.platform !== 'linux') return [];
    if (task.posixJobToken) return findPidsByEnvTokenSync(task.posixJobToken);
    if (task.result.executionStarted) throw new Error('旧 Linux 任务记录缺少清理令牌，无法确认逃逸后代停止；需要人工核对遗留进程。');
    return [];
  }
  private hasEscapedProcesses(task: TaskRecord): boolean {
    try { return this.escapedPids(task).length > 0; } catch { return true; }
  }
  public subscribe(id: string, listener: () => void): () => void {
    const remote = this.get(id)?.remote;
    let subscribers = this.listeners.get(id); if (!subscribers) this.listeners.set(id, subscribers = new Set());
    subscribers.add(listener);
    if (!this.watchers.has(id) && remote) this.watchers.set(id, setInterval(() => {
      try { this.get(id); } catch (error) { logger.warn('Task observation failed:', error); }
    }, 100));
    return () => { subscribers!.delete(listener); if (!subscribers!.size) {
      this.listeners.delete(id); clearInterval(this.watchers.get(id)); this.watchers.delete(id);
    } };
  }
  public async waitForRevision(id: string, revision: number, waitMs: number, signal?: AbortSignal): Promise<void> {
    const ready = () => { const task = this.get(id); return !task || task.result.status !== 'RUNNING' || task.result.revision !== revision; };
    if (ready() || waitMs <= 0 || signal?.aborted) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', finish); resolve(); };
      const unsubscribe = this.subscribe(id, () => { if (ready()) finish(); });
      const timer = setTimeout(finish, waitMs);
      signal?.addEventListener('abort', finish, { once: true }); if (ready() || signal?.aborted) finish();
    });
  }
  public async cancel(id: string, reason = 'CANCELLED'): Promise<TaskRecord | undefined> {
    const task = this.get(id); if (!task || task.result.status !== 'RUNNING') return task;
    if (task.remote) {
      const revision = task.result.revision;
      requestCancellation(task, reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED');
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const observed = this.get(id);
        if (!observed || observed.result.status !== 'RUNNING' || observed.result.revision !== revision && observed.result.errorCode && observed.result.currentPhase === 'STOPPING') return observed;
      }
      return this.get(id);
    }
    if (!task.cancellation) task.cancellation = (async () => {
      if (!task.abortController?.signal.aborted) task.abortController?.abort(reason);
      if (task.completion) await task.completion;
      if (task.result.status !== 'RUNNING') return;
      let targets: number[];
      try { targets = [...new Set([...task.childPids, ...this.escapedPids(task)])]; }
      catch (error) {
        this.update(task, { currentPhase: 'STOPPING', executionStatus: 'PROCESS_TERMINATION_UNCONFIRMED',
          errorCode: 'PROCESS_TERMINATION_UNCONFIRMED', errorMessage: String(error) }); return;
      }
      const stopped = await Promise.all(targets.map(pid => {
        const state = identityState(pid, task.childCreatedAt?.[pid], undefined, true);
        return state === 'EXITED' ? { verifiedTerminated: true } : state === 'UNKNOWN' ? { verifiedTerminated: false }
          : killProcessTree(pid, task.childCreatedAt?.[pid], task.posixJobToken);
      }));
      if (stopped.some(result => !result.verifiedTerminated) || this.hasEscapedProcesses(task)) {
        this.update(task, { currentPhase: 'STOPPING', executionStatus: 'PROCESS_TERMINATION_UNCONFIRMED', errorCode: 'PROCESS_TERMINATION_UNCONFIRMED' }); return;
      }
      task.childPids = []; releaseWorkspaceLease(id);
      const timedOut = task.abortController?.signal.reason === 'TIMEOUT';
      this.finish(task, { status: timedOut ? 'TIMEOUT' : 'CANCELLED', executionStatus: timedOut ? 'TIMEOUT' : 'CANCELLED',
        errorCode: timedOut ? 'TIMEOUT' : 'CANCELLED', response: task.result.response || 'Task stopped. File changes were retained.' });
    })();
    try { await task.cancellation; } finally { task.cancellation = undefined; }
    return task;
  }
  public async shutdownAll(): Promise<void> {
    const active = [...this.tasks.values()].filter(task => task.result.status === 'RUNNING');
    for (const task of active) {
      try { await this.cancel(task.result.taskId!, 'CANCELLED'); } catch (error) { logger.error('Task shutdown failed:', error); }
    }
  }
  public hasActiveTasks(): boolean { return [...this.tasks.values()].some(task => task.result.status === 'RUNNING'); }
}
export const taskTracker = new TaskTracker();
