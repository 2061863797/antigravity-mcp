#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { taskTracker } from './utils/task-tracker.js';
import { isCollected } from './utils/task-store.js';
import type { TaskResult } from './utils/register-tool.js';

// Claude Code 完成唤醒钩子：PostToolUse 以 asyncRewake 在后台运行。
// 工具返回仍在运行的任务时，等到任务结束，以退出码 2 把一句提示交给 Claude；
// 结果已经由工具返回过（collected 标记）时静默退出。任何内部错误都静默退出 0，不能影响被观察的工具调用。
// MCP 本身没有完成通知，这是 Claude Code 特有的机制；Codex 等其他客户端仍需自行查询。
export const DEFAULT_WAIT_MS = 60 * 60 * 1000;
const TASK_ID = /^task_[A-Za-z0-9_-]{1,190}$/;

// MCP 工具结果在钩子输入里的形状随客户端版本变化：可能是对象、content 数组里的 JSON 文本，或整段字符串。
// 逐层查找同时带 taskId 和 status 的对象。
export function extractTask(value: unknown, depth = 0): { taskId: string; status: string } | undefined {
  if (depth > 8 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) return undefined;
    try { return extractTask(JSON.parse(text), depth + 1); } catch { return undefined; }
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = extractTask(item, depth + 1); if (found) return found; }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.taskId === 'string' && TASK_ID.test(record.taskId) && typeof record.status === 'string') return { taskId: record.taskId, status: record.status };
  for (const key of ['structuredContent', 'data', 'content', 'text', 'result', 'output']) {
    const found = extractTask(record[key], depth + 1); if (found) return found;
  }
  for (const [key, item] of Object.entries(record)) {
    if (['structuredContent', 'data', 'content', 'text', 'result', 'output'].includes(key)) continue;
    const found = extractTask(item, depth + 1); if (found) return found;
  }
  return undefined;
}

export interface WakeDecision { exitCode: 0 | 2; message?: string }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function describe(result: TaskResult): string {
  const reason = result.status === 'SUCCESS' ? '成功' : [result.errorCode, result.exitReason].filter(Boolean).join('：');
  return result.status + (reason && result.status !== 'SUCCESS' ? `（${reason.slice(0, 300)}）` : '');
}

// 等待任务结束并决定是否唤醒；返回值便于测试，入口函数负责输出和退出码。
export async function decideWake(payload: unknown, options: { timeoutMs?: number; pollMs?: number; graceMs?: number } = {}): Promise<WakeDecision> {
  const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const started = extractTask(input.tool_response);
  if (!started || started.status !== 'RUNNING') return { exitCode: 0 };
  const id = started.taskId, pollMs = options.pollMs ?? 1000, end = Date.now() + (options.timeoutMs ?? DEFAULT_WAIT_MS);
  const who = typeof input.agent_type === 'string' && input.agent_type ? `（由子 agent ${input.agent_type} 启动）` : '';
  let task = taskTracker.get(id);
  while (task && task.result.status === 'RUNNING' && Date.now() < end) { await sleep(pollMs); task = taskTracker.get(id); }
  if (!task) return { exitCode: 0 };
  if (task.result.status === 'RUNNING') {
    return { exitCode: 2, message: `Antigravity 任务 ${id}${who} 等待 ${Math.round((options.timeoutMs ?? DEFAULT_WAIT_MS) / 60000)} 分钟后仍在运行，`
      + `完成唤醒已停止。需要结果时用 antigravity_status({"task_id":"${id}","wait_for":"terminal","wait_ms":60000}) 继续等待。` };
  }
  // 工具返回终态时才写标记，给它一点时间落盘，避免刚被取走的结果重复唤醒。
  const graceEnd = Date.now() + (options.graceMs ?? 1500);
  while (!isCollected(id) && Date.now() < graceEnd) await sleep(100);
  if (isCollected(id)) return { exitCode: 0 };
  return { exitCode: 2, message: `Antigravity 任务 ${id}${who} 已结束：${describe(task.result)}。`
    + `用 antigravity_status({"task_id":"${id}"}) 读取完整结果后再继续。` };
}

async function main(): Promise<void> {
  const timeoutArg = process.argv.indexOf('--timeout');
  const minutes = timeoutArg >= 0 ? Number(process.argv[timeoutArg + 1]) : NaN;
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  const decision = await decideWake(JSON.parse(data || '{}'), Number.isFinite(minutes) && minutes > 0 ? { timeoutMs: minutes * 60000 } : {});
  if (decision.message) process.stderr.write(decision.message + '\n');
  process.exitCode = decision.exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.exitCode = 0; });
}
