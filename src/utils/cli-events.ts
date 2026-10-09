import { StringDecoder } from 'node:string_decoder';

export interface CliProgressEvent { kind: 'initialization' | 'tool_start' | 'tool_update' | 'tool_end' | 'response' | 'upstream'; conversationId?: string; permissionMode?: string; tool?: string; file?: string; command?: string; success?: boolean; stepIndex?: number; stepId?: string; textDelta?: string }
const resultStatuses = ['SUCCESS', 'ERROR', 'CANCELED', 'CANCELLED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING'] as const;
export interface CliResultEnvelope { status: typeof resultStatuses[number]; response: string; conversation_id?: string; usage?: Record<string, unknown>; usageScope?: 'session' | 'unknown'; error?: string; duration_seconds?: number; command?: { name: string; data: Record<string, unknown> } }
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export class CliEventParser {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private steps = new Map<string, { progress: CliProgressEvent; ended: boolean }>();
  private conversation = '';
  private responseStep?: { index: number; ended: boolean };
  public envelope?: CliResultEnvelope;
  public protocolError?: string;
  public eventCount = 0;
  public unknownEventCount = 0;
  constructor(private readonly onEvent: (event: CliProgressEvent) => void = () => {}, private readonly limit = 5 * 1024 * 1024, private readonly readonlyCommand?: 'usage') {}
  public push(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline); this.pending = this.pending.slice(newline + 1); this.line(line);
    }
    if (Buffer.byteLength(this.pending) > this.limit) throw new Error('OUTPUT_LIMIT_EXCEEDED: individual CLI event');
  }
  public finish(): CliResultEnvelope | undefined {
    this.pending += this.decoder.end(); if (this.pending.trim()) this.line(this.pending); this.pending = '';
    return this.protocolError ? undefined : this.envelope;
  }
  private line(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > this.limit) throw new Error('OUTPUT_LIMIT_EXCEEDED: individual CLI event');
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (error) {
      if (error instanceof SyntaxError) { this.protocolError ??= 'CLI_OUTPUT_INVALID: invalid NDJSON event'; return; }
      else throw error;
    }
    this.event(value);
  }
  private event(value: unknown): void {
    const event = object(value);
    if (!event || typeof event.event !== 'string' || !event.event.trim()) {
      this.protocolError ??= 'CLI_OUTPUT_INVALID: expected an object with an event name'; return;
    }
    this.eventCount++;
    if (event.event === 'result') {
      const result = object(event.result);
      if (!result) this.protocolError = 'CLI_OUTPUT_INVALID: nested result must be an object';
      else this.result(result);
      return;
    }
    if (event.event === 'init') {
      const init = object(event.init);
      this.initialize(event.conversation_id ?? init?.conversation_id, init); return;
    }
    if (event.event === 'step_update') { this.step(object(event.step_update)); return; }
    if (event.event === 'command_result' && this.readonlyCommand) return;
    this.unknownEventCount++;
  }
  private identifyConversation(value: unknown): string | undefined {
    if (value === undefined || value === null) return this.conversation || undefined;
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
      this.protocolError = 'CLI_OUTPUT_INVALID: invalid conversation ID'; return undefined;
    }
    if (this.conversation && this.conversation !== value) {
      this.protocolError = 'CLI_OUTPUT_INVALID: conflicting conversation IDs'; return undefined;
    }
    this.conversation = value; return value;
  }
  private initialize(value: unknown, info?: Record<string, unknown>): void {
    const conversationId = this.identifyConversation(value);
    if (!this.protocolError) this.onEvent({ kind: 'initialization', ...(conversationId ? { conversationId } : {}),
      ...(typeof info?.permission_mode === 'string' ? { permissionMode: info.permission_mode.slice(0, 128) } : {}) });
  }
  private result(event: Record<string, unknown>): void {
    if (this.envelope) { this.protocolError = 'CLI_OUTPUT_INVALID: multiple final results for one prompt'; return; }
    if (!resultStatuses.includes(event.status as typeof resultStatuses[number])) {
      this.protocolError = 'CLI_OUTPUT_INVALID: invalid result status'; return;
    }
    const status = event.status as CliResultEnvelope['status'];
    const error = typeof event.error === 'string' ? event.error : undefined;
    if (event.response !== undefined && typeof event.response !== 'string') {
      this.protocolError = 'CLI_OUTPUT_INVALID: invalid response type'; return;
    }
    const response = typeof event.response === 'string' ? event.response : event.structured_output !== undefined ? JSON.stringify(event.structured_output)
      : status !== 'SUCCESS' ? '' : undefined;
    if (response === undefined) {
      this.protocolError = 'CLI_OUTPUT_INVALID: missing or invalid result content'; return;
    }
    const command = object(event.command), data = object(command?.data);
    if (this.readonlyCommand && status === 'SUCCESS' && (command?.name !== this.readonlyCommand || !data)) {
      this.protocolError = 'CLI_OUTPUT_INVALID: missing native command payload'; return;
    }
    const id = this.readonlyCommand && event.conversation_id === '' ? undefined : event.conversation_id;
    // 启动前失败的官方 ERROR 结果没有会话，空 ID 不能掩盖真正的错误。
    const conversationId = this.identifyConversation(status !== 'SUCCESS' && id === '' ? undefined : id);
    if (this.protocolError) return;
    this.envelope = { status, response, conversation_id: conversationId,
      usage: object(event.usage), usageScope: 'session', error,
      ...(this.readonlyCommand && command?.name === this.readonlyCommand && data ? { command: { name: this.readonlyCommand, data } } : {}),
      duration_seconds: typeof event.duration_seconds === 'number' && Number.isFinite(event.duration_seconds) && event.duration_seconds >= 0 ? event.duration_seconds : undefined };
  }
  private toolSuccess(event: Record<string, unknown>, info: Record<string, unknown> = {}): boolean | undefined {
    const output = object(info.output), records = [event, info, ...(output ? [output] : [])];
    const hasError = (value: unknown) => value !== undefined && value !== null && value !== false && value !== '';
    if (/^(ERROR|FAILED|FAILURE|CANCELLED|CANCELED)$/.test(String(event.state)) || records.some(item => hasError(item.error) || item.success === false || item.is_error === true || item.isError === true || item.status === 'ERROR')) return false;
    if (records.some(item => item.success === true || item.is_error === false || item.isError === false || item.status === 'SUCCESS')) return true;
    // DONE 和普通输出摘要只证明步骤结束，不能单独证明读取成功。
    return undefined;
  }
  private step(step: Record<string, unknown> | undefined): void {
    if (!step || !Number.isSafeInteger(step.step_index) || Number(step.step_index) < 0) { this.unknownEventCount++; return; }
    this.identifyConversation(step.conversation_id); if (this.protocolError) return;
    if (step.step_type === 'agent_response') {
      const index = Number(step.step_index);
      if (!['ACTIVE', 'DONE'].includes(String(step.state))) { this.unknownEventCount++; return; }
      if (this.responseStep && (index < this.responseStep.index || index === this.responseStep.index && this.responseStep.ended)) return;
      this.responseStep = { index, ended: step.state === 'DONE' };
      this.onEvent({ kind: 'response', stepIndex: index, stepId: this.conversation + ':' + index,
        ...(typeof step.text_delta === 'string' ? { textDelta: step.text_delta } : {}) }); return;
    }
    if (step.step_type === 'system_message' || step.step_type === 'finish' || step.step_type === 'checkpoint') { this.onEvent({ kind: 'upstream', stepIndex: Number(step.step_index) }); return; }
    if (step.step_type === 'user_input') return;
    if (step.step_type !== 'tool' || typeof step.state !== 'string' || !['ACTIVE', 'DONE', 'ERROR', 'FAILED', 'FAILURE', 'CANCELLED', 'CANCELED'].includes(step.state)) { this.unknownEventCount++; return; }
    const key = String(step.conversation_id ?? this.conversation) + ':' + step.step_index, previous = this.steps.get(key);
    if (previous?.ended) return;
    const info = object(step.tool_info) ?? {}, input = object(info.parameters) ?? {};
    const field = (...keys: string[]) => keys.map(name => input[name]).find((value): value is string => typeof value === 'string' && value.length > 0);
    const progress: CliProgressEvent = { kind: 'tool_start', stepIndex: Number(step.step_index), stepId: key,
      tool: (typeof step.tool_name === 'string' ? step.tool_name : typeof info.name === 'string' ? info.name : previous?.progress.tool)?.slice(0, 128),
      file: (field('AbsolutePath', 'TargetFile', 'file_path', 'path') ?? previous?.progress.file)?.slice(0, 32767),
      command: (field('CommandLine', 'command') ?? previous?.progress.command)?.slice(0, 2048) };
    const ended = step.state !== 'ACTIVE';
    this.steps.set(key, { progress, ended });
    if (this.steps.size > 128) this.steps.delete(this.steps.keys().next().value!);
    if (ended) this.onEvent({ ...progress, kind: 'tool_end', success: this.toolSuccess(step, info) });
    else if (!previous) this.onEvent(progress);
    else if (progress.tool !== previous.progress.tool || progress.file !== previous.progress.file || progress.command !== previous.progress.command) this.onEvent({ ...progress, kind: 'tool_update' });
  }
}
