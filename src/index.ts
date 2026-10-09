#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAntigravityServer } from './server.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  if (process.argv.slice(2).length) throw new Error('This server uses stdio only. Removed transport/status arguments are not supported.');
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
