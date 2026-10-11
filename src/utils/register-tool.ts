import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CallToolRequestSchema, type CallToolResult, type ServerRequest, type ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const handlers = new WeakMap<McpServer, Map<string, (args: unknown, extra: ToolExtra) => Promise<CallToolResult>>>();
const PhaseSchema = z.enum(['PREPARING', 'ANALYZING', 'CODING', 'STOPPING', 'IDLE']);
export const QuotaResultSchema = z.object({
  status: z.enum(['SUCCESS', 'ERROR']), checkedAt: z.string().datetime(),
  warnings: z.array(z.string().max(8192)).max(256), errorCode: z.string().nullable(), errorMessage: z.string().max(8192).nullable(),
  groups: z.array(z.object({ name: z.string().max(256), description: z.string().max(4096).optional(),
    buckets: z.array(z.object({ id: z.string().max(128), name: z.string().max(256), window: z.string().max(64),
      description: z.string().max(4096).optional(), remaining_fraction: z.number().min(0).max(1).nullable().default(null),
      reset_time: z.string().datetime({ offset: true }).nullable().default(null) })).max(16) })).max(16)
}).strict();
export type QuotaResult = z.infer<typeof QuotaResultSchema>;
export const ResultSchema = z.object({
  schemaVersion: z.literal(3), status: z.enum(['RUNNING', 'SUCCESS', 'ERROR', 'CANCELLED', 'TIMEOUT']), executionStatus: z.string(),
  taskId: z.string().nullable(), workspaceDir: z.string().nullable(), executionWorkspaceDir: z.string().nullable(),
  model: z.string().nullable(), effort: z.string().nullable(),
  cliMode: z.enum(['accept-edits', 'plan']).nullable().default(null), autoApprove: z.boolean().default(false),
  cliStatus: z.string().nullable().default(null), cliPermissionMode: z.string().nullable().default(null),
  stderrTail: z.string().default(''), usageScope: z.enum(['session', 'unknown']).default('unknown'),
  response: z.string(), errorCode: z.string().nullable(), cliError: z.string().nullable(), processExitCode: z.number().nullable(),
  conversationId: z.string().nullable(), executionStarted: z.boolean(), revision: z.number().int().nonnegative(), unchanged: z.boolean(),
  currentPhase: PhaseSchema, elapsedSeconds: z.number().nonnegative().nullable(),
  startedAt: z.string().nullable().default(null), lastObservedAt: z.string().nullable().default(null),
  lastActivity: z.object({ phase: PhaseSchema, tool: z.string().nullable(), file: z.string().nullable(), command: z.string().nullable() }).strict().nullable().default(null),
  failureStage: z.enum(['INPUT', 'PREPARING', 'CLI', 'RESULT', 'STOPPING', 'QUERY']).nullable().default(null),
  errorMessage: z.string().nullable().default(null), nextAction: z.string().nullable().default(null),
  lastOutputAt: z.string().nullable(), lastProgressAt: z.string().nullable(), activeTool: z.string().nullable(), activeFile: z.string().nullable(), recentCommand: z.string().nullable(),
  recentTools: z.array(z.object({ stepId: z.string(), stepIndex: z.number().int().nonnegative().nullable(),
    tool: z.string().nullable(), file: z.string().nullable(), command: z.string().nullable(),
    state: z.enum(['ACTIVE', 'DONE']), success: z.boolean().nullable() }).strict()).max(5).default([]),
  latestText: z.string().max(4000).default(''),
  managedProcess: z.enum(['NOT_STARTED', 'ALIVE', 'EXITED', 'UNKNOWN']), deadlineAt: z.string().nullable(),
  usage: z.record(z.unknown()).nullable(), upstreamDurationSeconds: z.number().nonnegative().nullable(),
  rawLog: z.object({ path: z.string(), maxBytes: z.number(), writtenBytes: z.number(), truncated: z.boolean() }).strict().nullable()
}).strict();
export type TaskResult = z.infer<typeof ResultSchema>;
export const TaskSummarySchema = z.object({
  summary: z.literal(true), taskId: ResultSchema.shape.taskId, status: ResultSchema.shape.status,
  revision: ResultSchema.shape.revision, unchanged: ResultSchema.shape.unchanged,
  executionStatus: ResultSchema.shape.executionStatus.optional(), currentPhase: PhaseSchema.optional(),
  elapsedSeconds: ResultSchema.shape.elapsedSeconds.optional(), managedProcess: ResultSchema.shape.managedProcess.optional(),
  lastProgressAt: ResultSchema.shape.lastProgressAt.optional(), lastActivity: ResultSchema.shape.lastActivity.optional(),
  activeTool: ResultSchema.shape.activeTool.optional(), activeFile: ResultSchema.shape.activeFile.optional(),
  recentCommand: z.string().max(512).nullable().optional(), errorCode: ResultSchema.shape.errorCode.optional(),
  failureStage: ResultSchema.shape.failureStage.optional(), errorMessage: z.string().max(512).nullable().optional(),
  nextAction: z.string().max(512).nullable().optional()
}).strict();
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
const brief = (text: string | null) => text === null ? null : text.slice(0, 512).replace(/[\uD800-\uDBFF]$/, '');
export function summarizeTask(result: TaskResult): TaskResult | TaskSummary {
  if (result.status !== 'RUNNING' && !result.unchanged) return result;
  const summary: TaskSummary = { summary: true, taskId: result.taskId, status: result.status,
    revision: result.revision, unchanged: result.unchanged };
  const diagnostic = !!result.errorCode || result.managedProcess === 'UNKNOWN' || result.currentPhase === 'STOPPING';
  if (!result.unchanged || diagnostic) Object.assign(summary, {
    executionStatus: result.executionStatus, currentPhase: result.currentPhase, elapsedSeconds: result.elapsedSeconds,
    managedProcess: result.managedProcess, lastProgressAt: result.lastProgressAt,
    lastActivity: result.lastActivity ? { ...result.lastActivity, command: brief(result.lastActivity.command) } : null,
    activeTool: result.activeTool, activeFile: result.activeFile, recentCommand: brief(result.recentCommand)
  });
  if (result.errorCode) Object.assign(summary, { errorCode: result.errorCode, failureStage: result.failureStage,
    errorMessage: brief(result.errorMessage), nextAction: brief(result.nextAction) });
  return summary;
}
export const StatusResultSchema = z.object({ schemaVersion: z.literal(3), kind: z.enum(['task', 'quota']),
  data: z.union([ResultSchema, TaskSummarySchema, QuotaResultSchema]) }).strict();
export function quotaFailure(code: string, message: string): QuotaResult {
  return { status: 'ERROR', checkedAt: new Date().toISOString(), groups: [], warnings: [], errorCode: code, errorMessage: message.slice(-8192) };
}
export function payloadStatus(kind: 'task' | 'quota', data: TaskResult | TaskSummary | QuotaResult): CallToolResult {
  const value = kind === 'task' ? ('summary' in data ? TaskSummarySchema.parse(data) : ResultSchema.parse(data)) : QuotaResultSchema.parse(data);
  const payload = { schemaVersion: 3 as const, kind, data: value };
  return { isError: value.status !== 'RUNNING' && value.status !== 'SUCCESS' || !!value.errorCode,
    content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}
function suggestNextAction(result: TaskResult): string {
  const code = result.errorCode;
  if (code === 'AGY_VERSION_UNSUPPORTED') return '按错误信息升级 agy 后重新提交；保持所选模型和后端，不自动重试。';
  if (code === 'AGY_VERSION_UNREADABLE') return '检查 AGY_PATH 与 agy --version 输出；必要时由用户明确设置 ANTIGRAVITY_SKIP_VERSION_CHECK=1 跳过版本预检，不自动重试。';
  if (code === 'CLI_BACKGROUND_ABORTED') return 'agy 结束时终止了后台任务，response 为部分结果。检查已有文件；如需继续，明确要求 agent 在前台运行验证、不要使用后台命令，再由用户决定是否续接，不自动重跑。';
  if (code === 'CLI_QUOTA_EXHAUSTED') return '额度不足，已有文件和已取得的会话保留。请用户选择由父 agent 接手，或等待额度恢复后在原目录使用原会话续接；选择前不要自动重试、换模型或接手。';
  if (code === 'PROCESS_TERMINATION_UNCONFIRMED' || code === 'LEASE_RELEASE_FAILED') return '继续查询并重试取消；确认进程停止和目录占用释放前，不重新提交。';
  if (code === 'WORKSPACE_BUSY') return '等待占用目录的任务结束，或用该任务 ID 在本机查询并明确取消；确认目录释放后再提交，不要重复执行。';
  if (code === 'TASK_NOT_FOUND') return '核对任务 ID；记录可能超过最近 100 项完成任务的保留范围，或来自不保存任务的旧版本。先检查保留文件；有已保存会话 ID 时可明确续接，不自动重跑。';
  if (code === 'TASK_RECORD_INVALID' || code === 'TASK_READ_FAILED') return '保留任务记录并检查格式或读取权限；不要删除现场、自动重跑或推断任务已经停止。';
  if (code === 'WORKER_INTERRUPTED') return '执行进程已退出；检查保留文件与响应片段，按原会话和实际目录明确续接，不自动重新执行。';
  if (code === 'CONVERSATION_UNKNOWN') return '核对会话 ID；记录确实不存在时，检查保留文件后明确新建会话。';
  if (code === 'CONVERSATION_RECORD_INVALID') return '保留损坏的会话记录并检查格式；不要覆盖记录或自动新建会话。';
  if (code === 'CONVERSATION_READ_FAILED' || code === 'CONVERSATION_SAVE_FAILED' || code === 'CONVERSATION_WORKSPACE_UNREADABLE') return '检查错误中的路径、权限和存储状态；执行已启动时，先确认进程停止并检查保留文件。';
  if (code === 'CONVERSATION_WORKSPACE_MISMATCH' || code === 'CONVERSATION_WORKSPACE_MISSING') return '确认原执行目录及会话绑定；不要把原会话迁移到其他目录。';
  if (code === 'INVALID_ARGUMENT' || code === 'INPUT_TOO_LARGE') return '修正输入参数后再提交。';
  if (code === 'CLI_WAITING') return 'CLI 在等待输入时结束；查看 stderrTail 和原会话，明确补足任务要求或权限后再决定续接，不自动重跑。';
  if (code === 'CLI_INCOMPLETE' || code === 'CLI_INVALID' || code === 'CLI_INTERRUPTED') return '查看 CLI 状态、诊断及保留文件；确认原进程停止后再决定续接，不自动重新提交。';
  if (result.failureStage === 'QUERY') return '核对任务 ID 和任务记录后重新查询；查询失败不表示原任务未执行，不重新提交编码。';
  if (!result.executionStarted && code !== 'CANCELLED' && code !== 'TIMEOUT') return '根据错误修正输入或执行环境后再提交。';
  return result.conversationId ? '先确认旧进程停止并检查保留文件；可明确使用原会话和原执行目录尝试续接。' : '先确认旧进程停止，检查保留文件和日志，再决定是否新建会话。';
}
export function addFailureDetails(result: TaskResult): TaskResult {
  if (result.errorCode) {
    result.failureStage ??= result.currentPhase === 'PREPARING' ? 'PREPARING'
      : result.currentPhase === 'STOPPING' ? 'STOPPING' : result.errorCode.startsWith('TASK_') ? 'QUERY'
      : ['INVALID_ARGUMENT', 'INPUT_TOO_LARGE', 'TOOL_NOT_FOUND', 'AGY_NOT_FOUND'].includes(result.errorCode) ? 'INPUT'
      : result.errorCode === 'CLI_OUTPUT_INVALID' ? 'RESULT'
      : ['CLI_ERROR', 'CLI_EXIT_FAILED', 'CLI_WAITING', 'CLI_INCOMPLETE', 'CLI_INVALID', 'CLI_INTERRUPTED', 'CLI_QUOTA_EXHAUSTED', 'CLI_BACKGROUND_ABORTED'].includes(result.errorCode) ? 'CLI' : null;
    result.errorMessage ??= result.cliError ?? result.errorCode;
    result.nextAction ??= suggestNextAction(result);
  } else { result.failureStage = null; result.errorMessage = null; result.nextAction = null; }
  return result;
}
export function normalizeResult(data: Partial<TaskResult> & Pick<TaskResult, 'status' | 'executionStatus'>): TaskResult {
  return addFailureDetails(ResultSchema.parse({ schemaVersion: 3, taskId: null, workspaceDir: null, executionWorkspaceDir: null,
    model: null, effort: null, response: '', errorCode: null, cliError: null, processExitCode: null, conversationId: null,
    executionStarted: false, revision: 0, unchanged: false, currentPhase: 'IDLE', elapsedSeconds: 0, lastOutputAt: null,
    lastProgressAt: null, activeTool: null, activeFile: null, recentCommand: null, managedProcess: 'NOT_STARTED', deadlineAt: null,
    usage: null, upstreamDurationSeconds: null, rawLog: null, ...data }));
}
export function payloadResult(data: Partial<TaskResult> & Pick<TaskResult, 'status' | 'executionStatus'>): CallToolResult {
  const payload = normalizeResult(data);
  return { isError: payload.status !== 'RUNNING' && payload.status !== 'SUCCESS' || !!payload.errorCode,
    content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}
export function registerTool<S extends z.ZodRawShape>(server: McpServer, name: string, description: string, shape: S,
  handler: (args: z.output<z.ZodObject<S>>, extra: ToolExtra) => Promise<CallToolResult>): void {
  const schema = z.object(shape).strict();
  const invoke = async (value: unknown, extra: ToolExtra): Promise<CallToolResult> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return toolFailure(name, value, 'INVALID_ARGUMENT', parsed.error.message, 'INPUT');
    try { return await handler(parsed.data, extra); }
    catch (error) {
      const code = /^[A-Z][A-Z_]+(?=:|$)/.exec(error instanceof Error ? error.message : String(error))?.[0] ?? 'TOOL_FAILED';
      return toolFailure(name, value, code, String(error), name === 'antigravity_status' || name === 'antigravity_cancel_task' ? 'QUERY' : 'INPUT');
    }
  };
  let tools = handlers.get(server); if (!tools) handlers.set(server, tools = new Map()); tools.set(name, invoke);
  server.registerTool(name, { description, inputSchema: schema, outputSchema: name === 'antigravity_status' ? StatusResultSchema : ResultSchema,
    annotations: { readOnlyHint: name === 'antigravity_status', destructiveHint: name === 'antigravity_code' || name === 'antigravity_ask',
      idempotentHint: name === 'antigravity_status' || name === 'antigravity_cancel_task',
      openWorldHint: name !== 'antigravity_cancel_task' } }, (args, extra) => invoke(args, extra));
}
function toolFailure(name: string, value: unknown, code: string, message: string, stage: TaskResult['failureStage']): CallToolResult {
  const args = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (name === 'antigravity_status' && args.task_id === undefined) return payloadStatus('quota', quotaFailure(code, message));
  const result = normalizeResult({ status: 'ERROR', executionStatus: code, errorCode: code, response: message, errorMessage: message,
    failureStage: stage, taskId: typeof args.task_id === 'string' ? args.task_id : null });
  return name === 'antigravity_status' ? payloadStatus('task', result) : payloadResult(result);
}
// 统一参数错误和正常结果的出口，保证文本与 structuredContent 完全一致。
export function installToolDispatcher(server: McpServer): void {
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.task) return toolFailure(request.params.name, request.params.arguments, 'INVALID_ARGUMENT', 'Use async_mode and antigravity_status instead of MCP task augmentation.', 'INPUT');
    const handler = handlers.get(server)?.get(request.params.name);
    return handler ? handler(request.params.arguments ?? {}, extra) : payloadResult({ status: 'ERROR', executionStatus: 'TOOL_NOT_FOUND', errorCode: 'TOOL_NOT_FOUND', response: 'Unknown tool: ' + request.params.name });
  });
}
