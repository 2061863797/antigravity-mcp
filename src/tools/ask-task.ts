import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from '../utils/register-tool.js';
import { taskInput, delegate } from './task-input.js';
export function registerAskTools(server: McpServer) {
  registerTool(server, 'antigravity_ask', '在传入目录调用支持官方 stream-json 的 agy 完成问答、分析、调研或审核，不强制进入规划流程。禁止修改是任务约束，不是系统级只读权限。返回任务、响应和诊断；用 antigravity_status 查询进度或按需查询额度。额度耗尽导致失败时，请用户选择父 agent 接手或恢复后续接。',
    taskInput, (args, extra) => delegate(args, true, extra.signal, extra._meta?.progressToken !== undefined ? { token: extra._meta.progressToken, send: extra.sendNotification } : undefined));
}
