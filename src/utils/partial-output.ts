import fs from 'node:fs';
import { logger } from './logger.js';

// 运行中把 agy 的全部回复文字按步骤追加到文件，进程被结束后仍能取回部分结论。
// 写入失败只记日志，不影响任务本身；超过上限后停止追加并标注。
export class PartialOutput {
  private bytes = 0;
  private step?: string;
  private full = false;
  private failed = false;
  constructor(private readonly file: string, private readonly maxBytes = 1024 * 1024) {
    try { fs.rmSync(file, { force: true }); } catch (error) { this.fail(error); }
  }
  private fail(error: unknown): void {
    if (!this.failed) logger.warn('Partial output persistence failed:', error);
    this.failed = true;
  }
  private append(text: string): void {
    if (this.failed || this.full || !text) return;
    const size = Buffer.byteLength(text);
    try {
      if (this.bytes + size > this.maxBytes) {
        fs.appendFileSync(this.file, '\n\n[部分结论记录已达 ' + this.maxBytes + ' 字节上限，后续文字未保存]\n');
        this.full = true; return;
      }
      fs.appendFileSync(this.file, text, { mode: 0o600 }); this.bytes += size;
    } catch (error) { this.fail(error); }
  }
  public text(stepId: string | undefined, delta: string | undefined): void {
    if (!delta) return;
    if (this.step !== stepId) { if (this.bytes) this.append('\n\n'); this.step = stepId; }
    this.append(delta);
  }
  // 失败收尾时附上已读文件和命令，便于续接时说明进度。
  public footer(files: string[], commands: string[]): void {
    const list = (items: string[], limit: number) => items.slice(-limit).map(item => '- ' + item.slice(0, 512)).join('\n')
      + (items.length > limit ? `\n- …另有 ${items.length - limit} 项` : '');
    const parts = ['\n\n---\n[执行中断时的进度]'];
    if (files.length) parts.push(`已读文件（${files.length}）：\n` + list(files, 40));
    if (commands.length) parts.push(`已运行命令（${commands.length}）：\n` + list(commands, 20));
    // 进度清单有条数上限，不受文字上限约束。
    if (parts.length > 1 && !this.failed) {
      try { fs.appendFileSync(this.file, parts.join('\n') + '\n', { mode: 0o600 }); } catch (error) { this.fail(error); }
    }
  }
  public get written(): boolean { return this.bytes > 0; }
}
