import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CliEventParser, type CliProgressEvent } from '../src/utils/cli-events.js';

test('captured agy 1.3.0 reads and continuation events keep valid final results', () => {
  for (const name of ['agy-1.3.0-read.jsonl', 'agy-1.3.0-continuation.jsonl']) {
    const events: CliProgressEvent[] = [], parser = new CliEventParser(event => events.push(event));
    const bytes = fs.readFileSync(path.resolve('test/fixtures', name));
    for (let index = 0; index < bytes.length; index += 13) parser.push(bytes.subarray(index, index + 13));
    const result = parser.finish(); assert.equal(result?.status, 'SUCCESS'); assert(result.conversation_id); assert(result.response);
    assert.equal(parser.unknownEventCount, 0); assert(events.some(event => event.kind === 'tool_start'));
    assert(events.some(event => event.kind === 'tool_end' && event.success === undefined));
  }
});
test('nested results preserve response, structured output, conversation, usage and duration', () => {
  const parser = new CliEventParser();
  parser.push(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: { summary: '中文' },
    conversation_id: 'conversation', usage: { input_tokens: 5 }, duration_seconds: 42 } }));
  assert.deepEqual(parser.finish(), { status: 'SUCCESS', response: '{"summary":"中文"}', conversation_id: 'conversation',
    usage: { input_tokens: 5 }, usageScope: 'session', error: undefined, duration_seconds: 42 });
});
test('initialization exposes a validated conversation ID before the final result', () => {
  for (const init of [{ event: 'init', conversation_id: 'early' }, { event: 'init', init: { conversation_id: 'early' } },
    { event: 'init', conversation_id: 'early', init: {} }]) {
    const events: CliProgressEvent[] = [], parser = new CliEventParser(event => events.push(event));
    const bytes = Buffer.from(JSON.stringify(init) + '\n');
    for (let index = 0; index < bytes.length; index += 3) parser.push(bytes.subarray(index, index + 3));
    assert.deepEqual(events, [{ kind: 'initialization', conversationId: 'early' }]);
    assert.equal(parser.envelope, undefined);
    parser.push('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
    assert.equal(parser.finish()?.conversation_id, 'early');
  }
});
test('invalid and conflicting conversation IDs cannot overwrite an earlier identity', () => {
  for (const value of ['', ' spaced ', 123, {}, 'x'.repeat(257), 'bad\u0000id']) {
    const events: CliProgressEvent[] = [], parser = new CliEventParser(event => events.push(event));
    parser.push(JSON.stringify({ event: 'init', conversation_id: value }) + '\n');
    assert.equal(events.length, 0); assert.match(parser.protocolError!, /invalid conversation ID/); assert.equal(parser.finish(), undefined);
  }
  const parser = new CliEventParser(); parser.push('{"event":"init","conversation_id":"first"}\n');
  parser.push('{"event":"result","result":{"status":"SUCCESS","response":"done","conversation_id":"second"}}\n');
  assert.equal(parser.finish(), undefined); assert.match(parser.protocolError!, /conflicting conversation IDs/);
});
test('nested errors and malformed results cannot be promoted to successful completion', () => {
  const error = new CliEventParser(); error.push(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'upstream failed' } }));
  assert.equal(error.finish()?.status, 'ERROR');
  for (const result of [undefined, null, [], {}, { status: 'OK', response: 'done' }, { status: 'SUCCESS', response: [] },
    { status: 'SUCCESS' }, { status: 'ERROR', response: {}, error: 'error cannot excuse malformed response' }]) {
    const parser = new CliEventParser(); parser.push(JSON.stringify({ event: 'result', result }));
    assert.equal(parser.finish(), undefined); assert(parser.protocolError);
  }
});
test('official non-success statuses and startup errors with an empty conversation ID retain their real cause', () => {
  for (const status of ['ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING']) {
    const parser = new CliEventParser(); parser.push(JSON.stringify({ event: 'result', result: { status, response: '',
      conversation_id: '', error: 'original error', usage: { total_tokens: 0 }, num_turns: 0 } }));
    const result = parser.finish(); assert.equal(result?.status, status); assert.equal(result.error, 'original error');
    assert.equal(result.conversation_id, undefined); assert.equal(result.usageScope, 'session'); assert.equal(parser.protocolError, undefined);
  }
});
test('valid empty responses and primitive structured output remain distinct from a missing result', () => {
  const empty = new CliEventParser(); empty.push('{"event":"result","result":{"status":"SUCCESS","response":""}}');
  assert.equal(empty.finish()?.response, '');
  for (const value of [0, false, '中文', null, ['a', 1]]) {
    const parser = new CliEventParser(); parser.push(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: value } }));
    assert.equal(parser.finish()?.response, JSON.stringify(value));
  }
  const raw = new CliEventParser(); raw.push('{"event":"result","result":{"status":"SUCCESS","response":"raw response\\n","structured_output":{"summary":"separate"}}}');
  assert.equal(raw.finish()?.response, 'raw response\n');
});
test('official checkpoint and permission events are recognized without turning completion into tool success', () => {
  const events: CliProgressEvent[] = [], parser = new CliEventParser(event => events.push(event));
  parser.push('{"event":"init","conversation_id":"known","init":{"permission_mode":"request-review"}}\n');
  parser.push('{"event":"step_update","step_update":{"conversation_id":"known","step_index":4,"step_type":"checkpoint","state":"DONE"}}\n');
  assert.equal(events[0].permissionMode, 'request-review'); assert.equal(events[1].kind, 'upstream'); assert.equal(parser.unknownEventCount, 0);
  parser.push('{"event":"step_update","step_update":{"conversation_id":"foreign","step_index":5,"step_type":"tool","state":"ACTIVE"}}\n');
  assert.equal(events.length, 2); assert.match(parser.protocolError!, /conflicting conversation IDs/);
});
test('a single submitted prompt rejects duplicate final results instead of selecting the last success', () => {
  const parser = new CliEventParser();
  parser.push('{"event":"result","result":{"status":"ERROR","error":"first failure"}}\n');
  parser.push('{"event":"result","result":{"status":"SUCCESS","response":"later success"}}\n');
  assert.equal(parser.finish(), undefined); assert.match(parser.protocolError!, /multiple final results/);
});
test('tool steps deduplicate starts, enrich metadata and separate completion from success', () => {
  const events: CliProgressEvent[] = [], parser = new CliEventParser(event => events.push(event));
  const send = (step_update: object) => parser.push(JSON.stringify({ event: 'step_update', step_update }) + '\n');
  const step = { step_index: 7, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command' };
  send(step); send(step); send({ ...step, tool_info: { parameters: { CommandLine: 'node test.cjs', TargetFile: 'a.txt' } } });
  send({ ...step, state: 'DONE' }); send({ ...step, state: 'DONE' });
  send({ ...step, step_index: 8, state: 'FAILED', error: 'failure' }); send({ ...step, step_index: 9, state: 'DONE', success: true });
  assert.deepEqual(events.map(event => event.kind), ['tool_start', 'tool_update', 'tool_end', 'tool_end', 'tool_end']);
  assert.equal(events[2].success, undefined); assert.equal(events[2].command, 'node test.cjs'); assert.equal(events[2].file, 'a.txt');
  assert.equal(events[3].success, false); assert.equal(events[4].success, true);
});
test('Chinese UTF-8 splits and several events per block preserve long final responses', () => {
  const response = '中文🙂\\引用'.repeat(3000), parser = new CliEventParser();
  const bytes = Buffer.from(JSON.stringify({ event: 'future_event' }) + '\n' +
    JSON.stringify({ event: 'step_update', step_update: { step_index: 2, step_type: 'agent_response', state: 'ACTIVE' } }) + '\n' +
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response } }));
  for (let index = 0; index < bytes.length; index += 7) parser.push(bytes.subarray(index, index + 7));
  assert.equal(parser.finish()?.response, response); assert.equal(parser.unknownEventCount, 1);
});
test('official response text deltas survive UTF-8 fragmentation and repeated or older completions are ignored', () => {
  const events: CliProgressEvent[] = [], parser = new CliEventParser(event => events.push(event));
  const steps = [
    { step_index: 2, step_type: 'agent_response', state: 'ACTIVE', text_delta: '中文🙂' },
    { step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: '\n' },
    { step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: '\n' },
    { step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: '新的文字' },
    { step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: '旧步骤' }
  ];
  const bytes = Buffer.from(steps.map(step_update => JSON.stringify({ event: 'step_update', step_update })).join('\n') + '\n');
  for (let index = 0; index < bytes.length; index += 2) parser.push(bytes.subarray(index, index + 2));
  assert.deepEqual(events.map(event => event.textDelta), ['中文🙂', '\n', '新的文字']);
  assert.deepEqual(events.map(event => event.stepIndex), [2, 2, 3]); assert.equal(parser.unknownEventCount, 0);
});
test('retired JSON and type envelopes are rejected without producing progress or a result', () => {
  for (const input of [
    JSON.stringify({ status: 'SUCCESS', response: 'retired' }),
    JSON.stringify({ status: 'SUCCESS', response: 'retired' }, null, 2),
    '{"type":"result","status":"SUCCESS","response":"retired"}',
    '{"type":"system","subtype":"init","session_id":"retired"}',
    '{"type":"tool_start","id":"old","name":"Read"}\n{"type":"tool_end","tool_use_id":"old"}',
    '{"type":"stream_event","event":{"content_block":{"type":"tool_use","name":"Read"}}}',
    '{"message":{"content":[{"type":"tool_use","name":"Read"}]}}'
  ]) {
    const events: CliProgressEvent[] = [], parser = new CliEventParser(event => events.push(event));
    parser.push(input); assert.equal(parser.finish(), undefined); assert.match(parser.protocolError!, /CLI_OUTPUT_INVALID/);
    assert.equal(events.length, 0);
  }
});
test('malformed NDJSON cannot be recovered from a later valid result or text around JSON', () => {
  const final = '{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n';
  for (const input of ['{broken}\n', 'diagnostic text\n', 'prefix ' + final, 'null\n', '[]\n', '"text"\n', '{"event":7}\n', '{"event":""}\n',
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'pretty' } }, null, 2) + '\n']) {
    const parser = new CliEventParser(); parser.push(input + final);
    assert.equal(parser.finish(), undefined); assert.match(parser.protocolError!, /CLI_OUTPUT_INVALID/);
  }
});
test('unknown event names are ignored and their response fields never become final results', () => {
  const parser = new CliEventParser(); parser.push('{"event":"future_event","status":"SUCCESS","response":"guess"}\n');
  assert.equal(parser.finish(), undefined); assert.equal(parser.protocolError, undefined); assert.equal(parser.unknownEventCount, 1);
  parser.push('{"event":"result","result":{"status":"SUCCESS","response":"official"}}\n');
  assert.equal(parser.finish()?.response, 'official');
});
test('stream consumption bounds individual events without retaining unknown tool output', () => {
  const parser = new CliEventParser(() => {}, 128);
  for (let index = 0; index < 100; index++) parser.push('{"event":"future_event","data":"small"}\n');
  parser.push('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n'); assert.equal(parser.finish()?.response, 'done');
  assert.throws(() => new CliEventParser(() => {}, 16).push('x'.repeat(17)), /OUTPUT_LIMIT_EXCEEDED/);
});
