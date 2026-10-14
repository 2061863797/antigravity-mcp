import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { z } from 'zod';
import { ResultSchema } from './register-tool.js';

export const stateHome = (): string => {
  const directory = process.env.ANTIGRAVITY_MCP_STATE_HOME ?? os.homedir();
  if (!path.isAbsolute(directory)) throw new Error('INVALID_CONFIG: state home must be absolute');
  return directory;
};
const root = () => path.join(stateHome(), '.gemini', 'antigravity-mcp-jobs-v1');
const RecordSchema = z.object({ version: z.literal(1), result: ResultSchema, startedAt: z.number().nonnegative(),
  childPids: z.array(z.number().int().positive()), ownerPid: z.number().int().positive(), workerPid: z.number().int().positive().nullable(),
  ownerCreatedAt: z.string().regex(/^[0-9]{1,30}$/).optional(), workerCreatedAt: z.string().regex(/^[0-9]{1,30}$/).optional(),
  childCreatedAt: z.record(z.string().regex(/^[1-9][0-9]{0,9}$/), z.string().regex(/^[0-9]{1,30}$/)).optional(),
  posixJobToken: z.string().uuid().optional(),
  token: z.string().uuid(), ready: z.boolean(), heartbeatAt: z.number().nonnegative(),
  lease: z.object({ file: z.string(), token: z.string().uuid() }).nullable() }).strict();
export type StoredTask = z.infer<typeof RecordSchema>;
export function taskFile(id: string, kind = 'task'): string {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('INVALID_TASK_ID');
  return path.join(root(), id + '.' + kind + '.json');
}
// 运行中持续追加的文字与进度记录；进程被结束后仍可从这里取回部分结论。
export function partialFile(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('INVALID_TASK_ID');
  return path.join(root(), id + '.partial.md');
}
// 终态结果已经由工具返回给调用方时写入标记；Claude Code 的完成唤醒钩子据此跳过重复唤醒。
export function collectedFile(id: string): string { return partialFile(id).replace(/\.partial\.md$/, '.collected'); }
export function markCollected(id: string): void {
  try { fs.writeFileSync(collectedFile(id), new Date().toISOString(), { mode: 0o600 }); } catch { /* 标记失败只会多一次唤醒。 */ }
}
export function isCollected(id: string): boolean { return fs.existsSync(collectedFile(id)); }
// 只读守卫每次判定追加一行，用来确认 agy 确实调用了守卫。
export function guardLogFile(id: string): string { return partialFile(id).replace(/\.partial\.md$/, '.readonly.log'); }
// 读取部分结论的尾部；文件不存在或不可读时返回 null，不影响任务状态。
export function readPartialTail(id: string, maxChars = 8000): string | null {
  try {
    const file = partialFile(id), size = fs.statSync(file).size, start = Math.max(0, size - maxChars * 4);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - start); fs.readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8').replace(/^�+/, '').slice(-maxChars).replace(/^[\uDC00-\uDFFF]/, '');
      return text.trim() ? text : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, file); break; }
      catch (error) {
        if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function saveTask(task: StoredTask): void {
  try { writeJson(taskFile(task.result.taskId!), RecordSchema.parse(task)); }
  catch (error) { throw new Error('TASK_SAVE_FAILED: ' + String(error)); }
}
// 记录文件的版本戳；原子替换会改变 inode 和修改时间，未变化时调用方可跳过重新解析。
export function taskStamp(id: string): string | undefined {
  try { const stat = fs.statSync(taskFile(id), { bigint: true }); return stat.ino + ':' + stat.size + ':' + stat.mtimeNs; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('TASK_READ_FAILED: ' + String(error));
  }
}
export function readTask(id: string): StoredTask | undefined {
  let bytes: string;
  try { bytes = fs.readFileSync(taskFile(id), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('TASK_READ_FAILED: ' + String(error));
  }
  try {
    const value = JSON.parse(bytes);
    // 只忽略已移除的历史额度字段，其余未知字段仍按严格记录格式校验。
    if (value?.result && typeof value.result === 'object') delete value.result.quota;
    const record = RecordSchema.parse(value);
    if (record.result.taskId !== id) throw new Error('Task ID mismatch');
    return record;
  } catch { throw new Error('TASK_RECORD_INVALID: ' + taskFile(id)); }
}
export function pruneTasks(): void {
  if (!fs.existsSync(root())) return;
  const completed: StoredTask[] = [];
  for (const file of fs.readdirSync(root()).filter(name => name.endsWith('.task.json'))) {
    try { const record = readTask(file.slice(0, -10)); if (record && record.result.status !== 'RUNNING') completed.push(record); }
    catch { /* 损坏记录保留，不能当作普通缓存删除。 */ }
  }
  const finished = (task: StoredTask) => Date.parse(task.result.lastObservedAt ?? '') || task.startedAt;
  completed.sort((left, right) => finished(right) - finished(left));
  for (const record of completed.slice(100)) {
    const id = record.result.taskId!;
    for (const file of [taskFile(id), partialFile(id), guardLogFile(id), collectedFile(id)]) {
      try { fs.unlinkSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
const CancelSchema = z.object({ token: z.string().uuid(), requestId: z.string().uuid(), reason: z.enum(['CANCELLED', 'TIMEOUT']) }).strict();
export function requestCancellation(task: StoredTask, reason: 'CANCELLED' | 'TIMEOUT'): void {
  writeJson(taskFile(task.result.taskId!, 'cancel'), { token: task.token, requestId: crypto.randomUUID(), reason });
}
export function readCancellation(task: StoredTask): z.infer<typeof CancelSchema> | undefined {
  try {
    const request = CancelSchema.parse(JSON.parse(fs.readFileSync(taskFile(task.result.taskId!, 'cancel'), 'utf8')));
    if (request.token !== task.token) throw new Error('Token mismatch');
    return request;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('TASK_CONTROL_INVALID: ' + String(error));
  }
}
export function removeTaskInput(id: string): void {
  for (const kind of ['launch', 'cancel']) {
    try { fs.unlinkSync(taskFile(id, kind)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
