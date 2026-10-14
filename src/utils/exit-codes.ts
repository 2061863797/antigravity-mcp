import os from 'node:os';

// Windows 退出码按 32 位无符号值比较；Node 可能给出有符号或无符号两种表示。
const windowsCodes: Record<number, string> = {
  0x40010004: 'agy 进程被外部强制结束（DBG_TERMINATE_PROCESS，例如任务管理器、调试器、终端或父进程清理进程树），不是 agy 自身报错',
  0xC000013A: 'agy 收到 Ctrl+C 或所在控制台窗口被关闭（STATUS_CONTROL_C_EXIT）',
  0xC0000005: 'agy 进程崩溃：内存访问冲突（STATUS_ACCESS_VIOLATION）',
  0xC00000FD: 'agy 进程崩溃：栈溢出（STATUS_STACK_OVERFLOW）',
  0xC0000409: 'agy 进程崩溃：栈缓冲区溢出检测（STATUS_STACK_BUFFER_OVERRUN）',
  0xC0000017: 'agy 进程内存不足（STATUS_NO_MEMORY）'
};

export const hexCode = (code: number) => '0x' + (code >>> 0).toString(16).toUpperCase().padStart(8, '0');

// 把进程退出码翻译成人话；无法识别时返回 undefined，由调用方保留原始码。
export function describeExitCode(code: number | null | undefined, platform = process.platform): string | undefined {
  if (code === null || code === undefined || code === 0) return undefined;
  if (platform === 'win32') {
    const known = windowsCodes[code >>> 0];
    if (known) return known;
    if (code === 1) return 'agy 以通用错误码 1 退出；查看 stderrTail 了解原因';
    return undefined;
  }
  if (code > 128 && code < 160) {
    const signal = Object.entries(os.constants.signals).find(([, value]) => value === code - 128)?.[0];
    if (signal === 'SIGKILL') return 'agy 进程被外部强制结束（SIGKILL），不是 agy 自身报错';
    if (signal === 'SIGTERM') return 'agy 进程被外部要求终止（SIGTERM）';
    if (signal === 'SIGINT') return 'agy 收到中断信号（Ctrl+C，SIGINT）';
    if (signal) return `agy 进程因信号 ${signal} 结束`;
  }
  if (code === 1) return 'agy 以通用错误码 1 退出；查看 stderrTail 了解原因';
  return undefined;
}

// 失败信息：人话 + 原始退出码（十进制和十六进制）。
export function exitFailureMessage(code: number | null, stderr: string): string {
  const reason = describeExitCode(code);
  const raw = code === null ? '无退出码' : `退出码 ${code}（${hexCode(code)}）`;
  const tail = stderr.trim().slice(-2048);
  return [reason ? reason + '。' : 'agy 非正常退出。', raw + '。', tail ? 'stderr 尾部：' + tail : ''].filter(Boolean).join('');
}
