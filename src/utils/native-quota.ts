import { CliEventParser } from './cli-events.js';
import { runManagedProcess } from './managed-process.js';
import { QuotaResultSchema, quotaFailure, type QuotaResult } from './register-tool.js';

export function quotaSnapshot(data: Record<string, unknown>): QuotaResult {
  const groups = QuotaResultSchema.shape.groups.parse(data.groups);
  const warnings = groups.flatMap(group => group.buckets
    .filter(bucket => bucket.remaining_fraction !== null && bucket.remaining_fraction <= 0.1)
    .map(bucket => `${group.name} / ${bucket.name}: 基础配额剩余 ${Math.round(bucket.remaining_fraction! * 1000) / 10}%，重置 ${bucket.reset_time ?? '未知'}。原生 credits 设置不变，快照不能保证整个任务有足够额度。`));
  return { status: 'SUCCESS', checkedAt: new Date().toISOString(), groups, warnings, errorCode: null, errorMessage: null };
}

// 只检查执行器的明确错误，不能从模型正文或单独的 HTTP 429 推断额度耗尽。
export function isQuotaExhaustion(message: string): boolean {
  if (/\b(per minute|per second|capacity|too many requests)\b/i.test(message)) return false;
  return /\b(?:quota|credits?)\s+(?:(?:is|are|has been|have been)\s+)?(?:exhausted|depleted|insufficient|used up|exceeded)\b/i.test(message)
    || /\b(?:insufficient|not enough|out of)\s+(?:AI\s+)?(?:quota|credits?)\b/i.test(message)
    || /\b(?:exhausted|depleted|used up)\s+(?:(?:your|the|available|AI)\s+)?(?:quota|credits?)\b/i.test(message)
    || /\b(?:billing|daily|weekly)\s+(?:cap|limit)\s+(?:exceeded|exhausted|reached)\b/i.test(message)
    || /(?:额度|配额)(?:已|已经|现已|目前)?(?:不足|耗尽|用完)|余额不足/.test(message);
}

export async function queryNativeQuota(executable: string, prefix: string[], options: {
  cwd: string; signal?: AbortSignal; onSpawn?: (pid: number) => void; onExit?: (pid: number) => void
}): Promise<QuotaResult> {
  const parser = new CliEventParser(undefined, 5 * 1024 * 1024, 'usage');
  let code = 'QUOTA_QUERY_FAILED';
  try {
    // 固定原生命令：没有任务提示、会话 ID 或 --disable-slash-commands。
    const output = await runManagedProcess(executable, [...prefix, '-p', '/usage', '--output-format', 'stream-json', '--print-timeout', '10s'], {
      ...options, timeoutMs: 15000, streamingOutput: true, onStdoutChunk: chunk => parser.push(chunk)
    });
    const envelope = parser.finish();
    code = !output.stopped ? 'PROCESS_TERMINATION_UNCONFIRMED' : options.signal?.aborted ? 'CANCELLED'
      : output.error === 'TIMEOUT' ? 'TIMEOUT' : parser.protocolError ? 'CLI_OUTPUT_INVALID' : 'QUOTA_QUERY_FAILED';
    if (!output.stopped || output.error || output.exitCode !== 0 || envelope?.status !== 'SUCCESS' || envelope.error?.trim() || !envelope.command || envelope.conversation_id) {
      throw new Error(envelope?.error || parser.protocolError || output.error || output.stderr.trim() || 'Native /usage query failed');
    }
    return quotaSnapshot(envelope.command.data);
  } catch (error) {
    return quotaFailure(code, String(error instanceof Error ? error.message : error));
  }
}
