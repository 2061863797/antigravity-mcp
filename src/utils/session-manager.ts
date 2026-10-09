import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalPath } from './paths.js';
import { stateHome } from './task-store.js';

const SessionSchema = z.object({ conversationId: z.string().min(1).max(256), workspaceDir: z.string().min(1),
  // 仅用于读取旧隔离会话的源目录别名；新会话只绑定实际目录。
  sourceWorkspaceDir: z.string().optional(),
  taskId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).optional(),
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional() });
type SessionSettings = Pick<z.infer<typeof SessionSchema>, 'model' | 'effort'>;
const same = (left: string, right: string) => {
  const normalize = (value: string) => process.platform === 'win32' ? canonicalPath(value).toLowerCase() : canonicalPath(value);
  return normalize(left) === normalize(right);
};
class SessionManager {
  private file(id: string, legacy = false): string {
    return path.join(stateHome(), '.gemini', legacy ? 'antigravity-mcp-conversations-v2' : 'antigravity-mcp-conversations-v3', crypto.createHash('sha256').update(id).digest('hex') + '.json');
  }
  private read(id: string, legacy = false): z.infer<typeof SessionSchema> | undefined {
    const file = this.file(id, legacy); let text: string;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('CONVERSATION_READ_FAILED: ' + String(error));
    }
    try { return SessionSchema.parse(JSON.parse(text)); }
    catch { throw new Error('CONVERSATION_RECORD_INVALID: ' + file); }
  }
  public resolve(id: string, source: string) {
    const record = this.read(id) ?? this.read(id, true);
    if (!record) throw new Error('CONVERSATION_UNKNOWN: no MCP session record for this conversation');
    if (record.conversationId !== id || !same(record.sourceWorkspaceDir ?? record.workspaceDir, source) && !same(record.workspaceDir, source)) throw new Error('CONVERSATION_WORKSPACE_MISMATCH');
    try {
      if (!fs.statSync(record.workspaceDir).isDirectory()) throw new Error('CONVERSATION_WORKSPACE_MISSING: execution path is not a directory');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CONVERSATION_WORKSPACE_MISSING')) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error((code === 'ENOENT' || code === 'ENOTDIR' ? 'CONVERSATION_WORKSPACE_MISSING: ' : 'CONVERSATION_WORKSPACE_UNREADABLE: ') + String(error));
    }
    return { ...record, workspaceDir: canonicalPath(record.workspaceDir) };
  }
  public save(id: string, workspaceDir: string, taskId?: string, settings?: SessionSettings): void {
    if (id.length > 256 || !id.trim() || id !== id.trim() || /[\x00-\x1f\x7f]/.test(id)) throw new Error('CONVERSATION_INVALID');
    const file = this.file(id);
    const existing = this.read(id) ?? this.read(id, true);
    if (existing && (existing.conversationId !== id || !same(existing.workspaceDir, workspaceDir))) throw new Error('CONVERSATION_WORKSPACE_MISMATCH');
    const record = SessionSchema.parse({ conversationId: id, workspaceDir: canonicalPath(workspaceDir),
      sourceWorkspaceDir: existing?.sourceWorkspaceDir, taskId: taskId ?? existing?.taskId,
      model: settings?.model ?? existing?.model, effort: settings?.effort ?? existing?.effort });
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(temp, JSON.stringify(record), { flag: 'wx' }); fs.renameSync(temp, file); }
      finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    } catch (error) { throw new Error('CONVERSATION_SAVE_FAILED: ' + String(error)); }
  }
}
export const sessionManager = new SessionManager();
