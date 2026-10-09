import path from 'node:path';
import { z } from 'zod';
import { executeAgy, type AgyExecuteOptions } from '../agy-executor.js';
import { payloadResult } from '../utils/register-tool.js';

export const taskInput = {
  prompt: z.string().trim().min(1).max(24000).describe('任务描述，最多 24,000 字符。Windows 转义后的命令行最多 30,000 字符。'),
  workspace_dir: z.string().trim().min(1).max(32767).refine(path.isAbsolute, 'workspace_dir must be absolute'),
  context: z.string().max(20000).optional().describe('补充上下文，最多 20,000 字符；仍受组合命令行长度限制。'),
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).optional(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('保持指定推理强度；CLI 或模型不支持时失败，不自动降档。'),
  cli_mode: z.enum(['accept-edits', 'plan']).optional().describe('默认 accept-edits，完成受托任务；只有明确需要规划流程时选择 plan。ask 的禁止修改约束独立于此模式。'),
  auto_approve: z.boolean().default(true).describe('默认 true，使用 agy 原生自动审批，批准所有工具，包括文件写入和命令。显式 false 时遵循本机 agy 权限配置和白名单。'),
  async_mode: z.boolean().optional().describe('默认同步等待；父 agent 有独立工作可并行推进或用户要求后台运行时传 true，用 antigravity_status 的 summary 视图查询。用户指定优先；不提供异步完成自动唤醒。已接受任务由独立 worker 执行，断线或重启后仍可查询和取消。'),
  timeout_minutes: z.number().positive().max(1440).optional().describe('可选同步等待期限，默认不设，等待真实终态；显式设置到期后返回任务 ID，后台继续运行。客户端自身可能有独立的工具超时。'),
  execution_timeout_minutes: z.number().positive().max(1440).optional().describe('独立执行期限，覆盖准备及 agy 执行；默认不设置。'),
  debug_log: z.boolean().optional().describe('默认 false，不保存原始输出；true 保存最多 5 MiB 的调试日志，解析仍消费完整输入。'),
  conversation_id: z.string().min(1).max(256).optional().describe('显式续接原执行目录中的会话；省略时新建会话。')
};
type DelegateInput = z.output<z.ZodObject<typeof taskInput>>;
export async function delegate(args: DelegateInput, analysis: boolean, signal?: AbortSignal,
  progress?: { token: string | number; send: (notification: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void> }) {
  const options: AgyExecuteOptions = { prompt: args.prompt, context: args.context, workspaceDir: args.workspace_dir, model: args.model,
    effort: args.effort, analysis, mode: args.cli_mode ?? 'accept-edits', autoApprove: args.auto_approve,
    conversationId: args.conversation_id, asyncMode: args.async_mode,
    debugLog: args.debug_log,
    requestWaitTimeoutMs: args.timeout_minutes === undefined ? undefined : args.timeout_minutes * 60000,
    executionTimeoutMs: args.execution_timeout_minutes === undefined ? undefined : args.execution_timeout_minutes * 60000, requestSignal: signal };
  if (progress) options.onProgress = (revision, message) => progress.send({ method: 'notifications/progress',
    params: { progressToken: progress.token, progress: revision, message } });
  return payloadResult(await executeAgy(options));
}
