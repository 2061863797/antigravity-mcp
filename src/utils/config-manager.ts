import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
const ConfigSchema = z.object({ defaultModel: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  defaultEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  // 调用方未传 auto_approve 时使用；省略时保持原有的 true。
  defaultAutoApprove: z.boolean().optional() }).strict();
export type AppConfig = z.infer<typeof ConfigSchema>;
const defaults: AppConfig = { defaultModel: 'gemini-3.8-flash-high', defaultEffort: 'high' };
export class ConfigManager {
  private readonly config: AppConfig;
  constructor(configPath?: string) {
    const explicit = configPath ?? process.env.ANTIGRAVITY_CONFIG_PATH;
    if (explicit && !path.isAbsolute(explicit)) throw new Error('INVALID_CONFIG: config path must be absolute');
    const file = explicit ?? fileURLToPath(new URL('../../config.json', import.meta.url));
    if (!fs.existsSync(file) && !explicit) { this.config = { ...defaults }; return; }
    try { this.config = ConfigSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (error) { throw new Error('INVALID_CONFIG (' + file + '): ' + String(error)); }
  }
  public getConfig(): AppConfig { return { ...this.config }; }
}
export const configManager = new ConfigManager();
