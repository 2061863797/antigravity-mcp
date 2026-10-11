import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getAgyExecutablePath } from './paths.js';
import { ensureAgyVersion, MIN_AGY_VERSION } from './agy-version.js';
import { stateHome } from './task-store.js';
import { powershellPath } from './process-identity.js';

export interface DoctorCheck { name: 'agy' | 'config' | 'stateDir' | 'powershell'; ok: boolean; skipped?: boolean; detail: Record<string, unknown> }
export interface DoctorReport { ok: boolean; checks: DoctorCheck[] }
export interface DoctorOptions {
  cliPath?: string; cliArgsPrefix?: string[]; platform?: NodeJS.Platform; languageMode?: () => string;
}
const message = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 4096);

// 只读预检：不调用模型、不创建任务或会话；状态目录只写入并删除一个探测文件。
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  try {
    const executable = options.cliPath ?? getAgyExecutablePath();
    try {
      const version = await ensureAgyVersion(executable, options.cliArgsPrefix ?? []);
      checks.push({ name: 'agy', ok: true, detail: { path: executable, version: version ?? null, minimum: MIN_AGY_VERSION,
        versionCheckSkipped: version === undefined } });
    } catch (error) {
      checks.push({ name: 'agy', ok: false, detail: { path: executable, minimum: MIN_AGY_VERSION,
        errorCode: (error as { code?: string }).code ?? 'AGY_VERSION_UNREADABLE', error: message(error) } });
    }
  } catch (error) { checks.push({ name: 'agy', ok: false, detail: { errorCode: 'AGY_NOT_FOUND', error: message(error) } }); }

  const configPath = process.env.ANTIGRAVITY_CONFIG_PATH ?? fileURLToPath(new URL('../../config.json', import.meta.url));
  try {
    // 配置在模块加载时解析；动态导入使无效配置成为检查结果而不是启动崩溃。
    const { configManager } = await import('./config-manager.js');
    const { defaultModel, defaultEffort, defaultAutoApprove } = configManager.getConfig();
    checks.push({ name: 'config', ok: true, detail: { path: configPath, exists: fs.existsSync(configPath), defaultModel, defaultEffort, defaultAutoApprove: defaultAutoApprove ?? true,
      note: '默认模型是否在 agy 账号中可用未经模型调用验证；不可用时由用户显式指定 model。' } });
  } catch (error) { checks.push({ name: 'config', ok: false, detail: { path: configPath, error: message(error) } }); }

  let jobs: string | undefined;
  try {
    jobs = path.join(stateHome(), '.gemini', 'antigravity-mcp-jobs-v1');
    fs.mkdirSync(jobs, { recursive: true });
    const probe = path.join(jobs, '.doctor-' + crypto.randomUUID() + '.tmp');
    fs.writeFileSync(probe, 'probe', { flag: 'wx' }); fs.unlinkSync(probe);
    checks.push({ name: 'stateDir', ok: true, detail: { path: jobs } });
  } catch (error) { checks.push({ name: 'stateDir', ok: false, detail: { path: jobs ?? null, error: message(error) } }); }

  if ((options.platform ?? process.platform) !== 'win32') {
    checks.push({ name: 'powershell', ok: true, skipped: true, detail: { reason: '仅 Windows 的 Job 启动器需要 PowerShell FullLanguage' } });
  } else {
    try {
      const mode = (options.languageMode ?? (() => execFileSync(powershellPath, ['-NoProfile', '-NonInteractive', '-Command',
        '$ExecutionContext.SessionState.LanguageMode'], { encoding: 'utf8', timeout: 10000, windowsHide: true })))().trim();
      checks.push({ name: 'powershell', ok: mode === 'FullLanguage', detail: { path: powershellPath, languageMode: mode,
        ...(mode === 'FullLanguage' ? {} : { hint: 'ConstrainedLanguage 等受限模式会让 Add-Type 编译的 Job 启动器失败；需由管理员调整 AppLocker/WDAC 策略后才能运行任务。' }) } });
    } catch (error) { checks.push({ name: 'powershell', ok: false, detail: { path: powershellPath, error: message(error) } }); }
  }
  return { ok: checks.every(check => check.ok), checks };
}
