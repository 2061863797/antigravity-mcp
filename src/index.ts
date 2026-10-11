#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--doctor') {
    // 预检只输出 JSON，不注册额外的 MCP 工具。
    const { runDoctor } = await import('./utils/doctor.js');
    const report = await runDoctor();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (argv.length) throw new Error('This server uses stdio only. Use --doctor for a preflight check; other arguments are not supported.');
  const { createAntigravityServer } = await import('./server.js');
  const server = createAntigravityServer();
  let closing: Promise<void> | undefined;
  const shutdown = () => {
    if (closing) return closing;
    const timer = setTimeout(() => process.exit(1), 60000); timer.unref();
    closing = (async () => {
      try { await server.close(); }
      catch (error) { logger.error('Shutdown failed:', error); }
      finally { process.exit(0); }
    })();
    return closing;
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown); process.stdin.on('close', shutdown);
  await server.connect(new StdioServerTransport());
}
main().catch(error => { logger.error('MCP startup failed:', error); process.exit(1); });
