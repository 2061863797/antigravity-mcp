import path from 'node:path';
import { z } from 'zod';
import { executeAgy, type AgyExecuteOptions } from '../agy-executor.js';
import { payloadResult } from '../utils/register-tool.js';
import { markCollected } from '../utils/task-store.js';

export const taskInput = {
  prompt: z.string().trim().min(1).max(24000).describe('任务描述，最多 24,000 字符。Windows 转义后的命令行最多 30,000 字符。'),
  workspace_dir: z.string().trim().min(1).max(32767).refine(path.isAbsolute, 'workspace_dir must be absolute'),
  context: z.string().max(20000).optional().describe('补充上下文，最多 20,000 字符；仍受组合命令行长度限制。'),
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).optional(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('保持指定推理强度；CLI 或模型不支持时失败，不自动降档。'),
  cli_mode: z.enum(['accept-edits', 'plan']).optional().describe('默认 accept-edits，完成受托任务；只有明确需要规划流程时选择 plan。ask 的禁止修改约束独立于此模式。'),
  auto_approve: z.boolean().default(true).describe('默认 true，使用 agy 原生自动审批，批准所有工具，包括文件写入和命令。显式 false 时遵循本机 agy 权限配置和白名单。省略时若服务配置了 defaultAutoApprove 则以配置为准；显式传值优先。'),
  async_mode: z.boolean().optional().describe('默认 false（同步）。MCP 本身在任务完成时没有任何通知；只有 Claude Code 安装了本插件（自带完成唤醒钩子）时，'
    + '仍在运行的任务结束后会以系统提示唤醒你，其他客户端（如 Codex）只能主动查询。'
    + '在 agy 完成前你没有别的工作可做（例如只是等审核结果）时，用同步模式并设置 timeout_minutes。'
    + '只有确实要同时推进其他工作，或用户要求后台运行时才传 true；之后有完成唤醒就等唤醒，没有就用 antigravity_status 加 wait_for:"terminal" 查询，每次最多等 wait_ms，不要按 revision 高频轮询。'
    + '已接受任务由独立 worker 执行，断线或重启后仍可用 taskId 查询和取消。'),
  timeout_minutes: z.number().positive().max(1440).optional().describe('同步等待期限（分钟）。设置为略小于客户端单次工具调用超时的值'
    + '（Codex 看该 MCP 的 tool_timeout_sec，Claude Code 看其 MCP 工具超时）。到期返回 status RUNNING 和 taskId，任务在后台继续，'
    + '再用 antigravity_status 加 wait_for:"terminal" 等到结束（Claude Code 插件用户也可以结束本回合，等完成唤醒）。不设则一直等到终态，可能被客户端工具超时打断。'),
  execution_timeout_minutes: z.number().positive().max(1440).optional().describe('独立执行期限，覆盖准备及 agy 执行；默认不设置。'),
  debug_log: z.boolean().optional().describe('默认 false，不保存原始输出；true 保存最多 5 MiB 的调试日志，解析仍消费完整输入。'),
  conversation_id: z.string().min(1).max(256).optional().describe('显式续接原执行目录中的会话；省略时新建会话。')
};
// 只读权限只对问答、分析和审核开放；编码任务需要写文件。
export const askInput = { ...taskInput,
  read_only: z.boolean().optional().describe('默认 false。true 时由 agy 钩子硬性拦截：只允许读文件、搜索和只读命令（如 git status/diff/log、rg、Get-Content），'
    + '写文件、编辑和其他命令一律被拒绝；任务提示中的“不要修改”只是约束，不等于只读。审核、复核、调研类任务推荐传 true。') };
type DelegateInput = z.output<z.ZodObject<typeof taskInput>> & { read_only?: boolean };
// schema 的默认值保持 true；只有调用方未显式传入时，才交给执行器按 defaultAutoApprove 决定。
export function requestedAutoApprove(args: Pick<DelegateInput, 'auto_approve'>, raw: unknown): boolean | undefined {
  return !!raw && typeof raw === 'object' && Object.hasOwn(raw, 'auto_approve') ? args.auto_approve : undefined;
}
export async function delegate(args: DelegateInput, analysis: boolean, signal?: AbortSignal,
  progress?: { token: string | number; send: (notification: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void> },
  raw?: unknown) {
  const options: AgyExecuteOptions = { prompt: args.prompt, context: args.context, workspaceDir: args.workspace_dir, model: args.model,
    effort: args.effort, analysis, mode: args.cli_mode ?? 'accept-edits', autoApprove: requestedAutoApprove(args, raw),
    ...(args.read_only ? { readOnly: true } : {}),
    conversationId: args.conversation_id, asyncMode: args.async_mode,
    debugLog: args.debug_log,
    requestWaitTimeoutMs: args.timeout_minutes === undefined ? undefined : args.timeout_minutes * 60000,
    executionTimeoutMs: args.execution_timeout_minutes === undefined ? undefined : args.execution_timeout_minutes * 60000, requestSignal: signal };
  if (progress) options.onProgress = (revision, message) => progress.send({ method: 'notifications/progress',
    params: { progressToken: progress.token, progress: revision, message } });
  const result = await executeAgy(options);
  // 同步调用已直接拿到终态结果，完成唤醒钩子不必再唤醒。
  if (result.taskId && result.status !== 'RUNNING') markCollected(result.taskId);
  return payloadResult(result);
}
