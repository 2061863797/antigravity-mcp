import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import os from 'node:os';
import { taskTracker } from '../utils/task-tracker.js';
import { registerTool, payloadResult, payloadStatus, normalizeResult, summarizeTask } from '../utils/register-tool.js';
import { queryNativeQuota } from '../utils/native-quota.js';
import { getAgyExecutablePath } from '../utils/paths.js';
const input = { task_id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) };
const missing = (id: string) => payloadResult({ status: 'ERROR', executionStatus: 'TASK_NOT_FOUND', errorCode: 'TASK_NOT_FOUND', taskId: id });
export function registerSystemTools(server: McpServer) {
  registerTool(server, 'antigravity_status', '带 task_id 查询任务，返回 kind: task；可带 after_revision、wait_ms（0–60000）和 view（默认 full）。轮询用 summary：同版本返回最小简报，变化返回进度和必要诊断，新终态返回完整结果；完整读取用 full 并省略游标。不带 task_id 查询原生额度，不能传 view、游标或等待参数，不启动模型或占用项目目录。两种结果均从 data 读取。', {
    task_id: input.task_id.optional(), after_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    wait_ms: z.number().int().min(0).max(60000).optional(), view: z.enum(['full', 'summary']).optional()
  }, async ({ task_id, after_revision, wait_ms, view }, extra) => {
    if (task_id === undefined) {
      if (after_revision !== undefined || wait_ms !== undefined || view !== undefined) throw new Error('INVALID_ARGUMENT: view, after_revision and wait_ms require task_id');
      return payloadStatus('quota', await queryNativeQuota(getAgyExecutablePath(), [], { cwd: os.homedir(), signal: extra.signal }));
    }
    if (after_revision !== undefined) await taskTracker.waitForRevision(task_id, after_revision, wait_ms ?? 0, extra.signal);
    const task = taskTracker.get(task_id);
    const result = task ? taskTracker.report(task, after_revision === task.result.revision)
      : normalizeResult({ status: 'ERROR', executionStatus: 'TASK_NOT_FOUND', errorCode: 'TASK_NOT_FOUND', taskId: task_id });
    return payloadStatus('task', view === 'summary' ? summarizeTask(result) : result);
  });
  registerTool(server, 'antigravity_cancel_task', '停止指定任务和子进程，保留文件改动。确认进程停止才释放工作区；重复取消已完成任务不会改变结果。', input,
    async ({ task_id }) => { const task = await taskTracker.cancel(task_id); return task ? payloadResult(taskTracker.report(task)) : missing(task_id); });
}
