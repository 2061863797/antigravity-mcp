import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from '../utils/register-tool.js';
import { taskInput, delegate } from './task-input.js';
export function registerCodeTools(server: McpServer) {
  registerTool(server, 'antigravity_code', '在传入目录调用支持官方 stream-json 的 agy 完成编码。用 antigravity_status 查询进度或按需查询额度，任务不自动查额度。失败和取消保留改动；额度耗尽导致失败时，请用户选择父 agent 接手或恢复后续接。SUCCESS 只表示调用成功，父 agent 负责检查文件、运行测试和验收。',
    taskInput, (args, extra) => delegate(args, false, extra.signal, extra._meta?.progressToken !== undefined ? { token: extra._meta.progressToken, send: extra.sendNotification } : undefined));
}
