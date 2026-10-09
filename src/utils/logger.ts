/**
 * Safe logger for MCP Server.
 * In stdio mode, process.stdout is strictly reserved for JSON-RPC protocol messages.
 * Any log message written to stdout will corrupt the protocol stream.
 * Therefore, all logs are routed to process.stderr.
 */

const formatArg = (a: unknown): string => {
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (typeof a === 'object' && a !== null) return JSON.stringify(a);
  return String(a);
};

export const logger = {
  info: (...args: unknown[]) => {
    process.stderr.write(`[INFO] ${args.map(formatArg).join(' ')}\n`);
  },
  warn: (...args: unknown[]) => {
    process.stderr.write(`[WARN] ${args.map(formatArg).join(' ')}\n`);
  },
  error: (...args: unknown[]) => {
    process.stderr.write(`[ERROR] ${args.map(formatArg).join(' ')}\n`);
  },
  debug: (...args: unknown[]) => {
    if (process.env.DEBUG === '1' || process.env.DEBUG === 'true') {
      process.stderr.write(`[DEBUG] ${args.map(formatArg).join(' ')}\n`);
    }
  }
};
