import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSystemTools } from './tools/system-tools.js';
import { registerAskTools } from './tools/ask-task.js';
import { registerCodeTools } from './tools/code-task.js';
import { installToolDispatcher } from './utils/register-tool.js';
export function createAntigravityServer(): McpServer {
  const server = new McpServer({ name: 'antigravity-mcp-server', version: '2.0.0' }, {
    instructions: '调用本机 agy 的子代理通道。明确传入任务和工作区；已接受任务独立执行，客户端重连后可用原任务 ID 查询结果或取消，显式会话 ID 可续接。默认自动审批，失败保留改动。父 agent 负责检查文件和判断结果。'
  });
  registerCodeTools(server); registerAskTools(server); registerSystemTools(server); installToolDispatcher(server);
  return server;
}
