import fs from 'node:fs';
import { z } from 'zod';
import { taskTracker } from './utils/task-tracker.js';
import { readTask, saveTask, taskFile, readCancellation, removeTaskInput } from './utils/task-store.js';
import { normalizeResult } from './utils/register-tool.js';
import { releaseWorkspaceLease } from './utils/workspace-lease.js';
import type { AgyExecuteOptions } from './agy-executor.js';

const id = process.argv[2];
process.stderr.on('error', () => {});
const launchSchema = z.object({ token: z.string().uuid(), options: z.record(z.unknown()) }).strict();
async function main(): Promise<void> {
  let timer: ReturnType<typeof setInterval> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const input = launchSchema.parse(JSON.parse(fs.readFileSync(taskFile(id, 'launch'), 'utf8')));
    const end = Date.now() + 5000;
    let record = readTask(id);
    while (record?.workerPid !== process.pid && Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 10)); record = readTask(id);
    }
    if (!record || record.workerPid !== process.pid || record.token !== input.token || !record.lease) throw new Error('WORKER_BINDING_INVALID');
    while (JSON.parse(fs.readFileSync(record.lease.file, 'utf8')).ownerPid !== process.pid && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    fs.unlinkSync(taskFile(id, 'launch'));
    let lastRequest: string | undefined;
    timer = setInterval(() => {
      try {
        const task = taskTracker.get(id); if (!task || task.result.status !== 'RUNNING') return;
        const request = readCancellation(task);
        if (request && request.requestId !== lastRequest) {
          lastRequest = request.requestId;
          void taskTracker.cancel(id, request.reason).catch(error => {
            taskTracker.update(task, { currentPhase: 'STOPPING', errorCode: 'TASK_CANCEL_FAILED', executionStatus: 'TASK_CANCEL_FAILED', errorMessage: String(error) });
          });
        }
      } catch (error) { taskTracker.get(id)?.abortController?.abort('TASK_CONTROL_INVALID'); }
    }, 100);
    heartbeat = setInterval(() => {
      const task = taskTracker.get(id); if (task && !task.remote) {
        try { taskTracker.heartbeat(task); } catch { task.abortController?.abort('TASK_SAVE_FAILED'); }
      }
    }, 1000);
    const { executeAgy } = await import('./agy-executor.js');
    const result = await executeAgy(input.options as unknown as AgyExecuteOptions, id);
    const task = taskTracker.get(id);
    if (!task) throw new Error('TASK_NOT_FOUND');
    if (!task.completion && result.status !== 'RUNNING') {
      task.remote = false; taskTracker.finish(task, { ...result, status: result.status, taskId: id });
    }
    await task.completion;
    // 未确认停止时继续持有控制通道和租约，允许重连后的取消重试。
    while (task.result.status === 'RUNNING') await new Promise(resolve => setTimeout(resolve, 100));
  } catch (error) {
    const local = taskTracker.get(id);
    if (local && !local.remote && local.result.status === 'RUNNING') {
      try { await taskTracker.cancel(id, 'WORKER_FAILED'); } catch { /* 控制轮询保留，允许取消重试。 */ }
      if (local.result.status === 'RUNNING') {
        taskTracker.update(local, { currentPhase: 'STOPPING', executionStatus: 'PROCESS_TERMINATION_UNCONFIRMED',
          errorCode: 'PROCESS_TERMINATION_UNCONFIRMED', errorMessage: String(error) });
        while (local.result.status === 'RUNNING') await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const record = readTask(id);
    if (record?.result.status === 'RUNNING') saveTask({ ...record, ready: true, result: normalizeResult({ ...record.result,
      status: 'ERROR', executionStatus: 'WORKER_FAILED', errorCode: 'WORKER_FAILED', errorMessage: String(error),
      revision: record.result.revision + 1, stderrTail: String(error).slice(-8192), currentPhase: 'IDLE', failureStage: 'PREPARING' }) });
    releaseWorkspaceLease(id);
  } finally {
    clearInterval(timer); clearInterval(heartbeat); removeTaskInput(id);
  }
}
main().then(() => process.exit(0)).catch(error => { process.stderr.write(String(error)); process.exit(1); });
