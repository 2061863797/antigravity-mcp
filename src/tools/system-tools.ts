import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import os from 'node:os';
import { taskTracker } from '../utils/task-tracker.js';
import { registerTool, payloadResult, payloadStatus, normalizeResult, summarizeTask } from '../utils/register-tool.js';
import { queryNativeQuota } from '../utils/native-quota.js';
import { getAgyExecutablePath } from '../utils/paths.js';
import { markCollected } from '../utils/task-store.js';
const input = { task_id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) };
const missing = (id: string) => payloadResult({ status: 'ERROR', executionStatus: 'TASK_NOT_FOUND', errorCode: 'TASK_NOT_FOUND', taskId: id });
export function registerSystemTools(server: McpServer) {
  registerTool(server, 'antigravity_status', '带 task_id 查询任务，返回 kind: task。MCP 在任务完成时不会主动通知（Claude Code 插件的完成唤醒除外，被唤醒后直接用 task_id 读取即可），需要结果时这样等：'
    + 'wait_for:"terminal" 加 wait_ms（0–60000），只在任务结束或需要处理的错误时提前返回，普通工具调用不会打断等待；仍在运行时返回进度摘要，再用同样参数继续等即可。'
    + 'Codex 未调大该 MCP 的 tool_timeout_sec（默认约 60 秒）时 wait_ms 用 50000 以内。wait_for:"progress" 在阶段变化或进度明显变化（每读 10 个文件、每跑 5 条命令）时也返回。'
    + '默认 wait_for:"revision" 需配合 after_revision，任何细小变化都会返回，不适合长时间等待。view 默认 full；summary 返回进度（已读文件数、命令数、已用时间、阶段），终态返回完整结果。'
    + '不带 task_id 查询原生额度，不能传 view、wait_for、游标或等待参数，不启动模型或占用项目目录。两种结果均从 data 读取。', {
    task_id: input.task_id.optional(), after_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    wait_ms: z.number().int().min(0).max(60000).optional(), view: z.enum(['full', 'summary']).optional(),
    wait_for: z.enum(['revision', 'progress', 'terminal']).optional()
  }, async ({ task_id, after_revision, wait_ms, view, wait_for }, extra) => {
    if (task_id === undefined) {
      if (after_revision !== undefined || wait_ms !== undefined || view !== undefined || wait_for !== undefined) throw new Error('INVALID_ARGUMENT: view, wait_for, after_revision and wait_ms require task_id');
      return payloadStatus('quota', await queryNativeQuota(getAgyExecutablePath(), [], { cwd: os.homedir(), signal: extra.signal }));
    }
    if (wait_for === 'terminal' || wait_for === 'progress') {
      const baseline = wait_for === 'progress' ? taskTracker.get(task_id)?.result.progressRevision : undefined;
      await taskTracker.waitForTerminal(task_id, wait_ms ?? 0, extra.signal, baseline);
    } else if (after_revision !== undefined) await taskTracker.waitForRevision(task_id, after_revision, wait_ms ?? 0, extra.signal);
    const task = taskTracker.get(task_id);
    const result = task ? taskTracker.report(task, after_revision === task.result.revision)
      : normalizeResult({ status: 'ERROR', executionStatus: 'TASK_NOT_FOUND', errorCode: 'TASK_NOT_FOUND', taskId: task_id });
    if (task && result.status !== 'RUNNING') markCollected(task_id);
    return payloadStatus('task', view === 'summary' ? summarizeTask(result) : result);
  });
  registerTool(server, 'antigravity_cancel_task', '停止指定任务和子进程，保留文件改动。确认进程停止才释放工作区；重复取消已完成任务不会改变结果。', input,
    async ({ task_id }) => {
      const task = await taskTracker.cancel(task_id); if (!task) return missing(task_id);
      const result = taskTracker.report(task); if (result.status !== 'RUNNING') markCollected(task_id);
      return payloadResult(result);
    });
}
