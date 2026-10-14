import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from '../utils/register-tool.js';
import { askInput, delegate } from './task-input.js';
export function registerAskTools(server: McpServer) {
  registerTool(server, 'antigravity_ask', '在传入目录调用支持官方 stream-json 的 agy 完成问答、分析、调研或审核，不强制进入规划流程。'
    + '审核和复核推荐传 read_only: true（钩子硬性拦截写文件和有副作用的命令）；不传时“禁止修改”只是任务约束。'
    + '怎么等结果：MCP 完成时不会通知你（只有 Claude Code 装了本插件时，仍在运行的任务结束会唤醒你）。若在结果出来前你没有其他工作，用默认同步模式并设 timeout_minutes（略小于客户端工具超时），'
    + '到期返回 RUNNING 后有完成唤醒就结束本回合等唤醒，否则用 antigravity_status 加 wait_for:"terminal" 继续等；只有确实要并行做别的事才用 async_mode: true。失败时结果给出原因（exitReason）、已保存的部分结论（partialResponse）和续接示例（resumeExample）。'
    + '额度耗尽导致失败时，请用户选择父 agent 接手或恢复后续接。',
    askInput, (args, extra, raw) => delegate(args, true, extra.signal, extra._meta?.progressToken !== undefined ? { token: extra._meta.progressToken, send: extra.sendNotification } : undefined, raw));
}
