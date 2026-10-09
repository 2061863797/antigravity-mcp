import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaSnapshot, isQuotaExhaustion } from '../src/utils/native-quota.js';
import { CliEventParser } from '../src/utils/cli-events.js';
import { normalizeResult } from '../src/utils/register-tool.js';

const data = (weekly: number | null = 0.9, fiveHour = 0.8) => ({ groups: [
  { name: 'Gemini Models', description: 'Gemini Flash and Pro share both limits', buckets: [
    { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: weekly, reset_time: '2050-10-13T14:27:34Z' },
    { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: fiveHour, reset_time: '2050-10-08T14:09:09Z' }
  ] },
  { name: 'Claude and GPT models', buckets: [
    { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0, reset_time: '2050-10-15T11:57:37Z' }
  ] }
] });

test('native quota retains all groups and their independent limits without selecting a model', () => {
  const quota = quotaSnapshot(data());
  assert.equal(quota.status, 'SUCCESS'); assert.equal(quota.errorCode, null); assert.equal(quota.groups.length, 2);
  assert.equal(quota.groups[0].buckets[0].remaining_fraction, 0.9);
  assert.equal(quota.groups[0].buckets[0].reset_time, '2050-10-13T14:27:34Z');
  assert(!('selectedGroup' in quota)); assert(!('state' in quota));
});
test('low quota warns before depletion and never uses another group to declare Gemini exhausted', () => {
  const quota = quotaSnapshot(data(0.1));
  assert(quota.warnings.some(text => text.includes('Gemini Models') && text.includes('10%')));
  assert(quota.warnings.some(text => text.includes('Claude and GPT models') && text.includes('0%')));
  assert(quota.warnings.every(text => /2050-10-/.test(text)));
  assert(!quotaSnapshot(data(0.1001)).warnings.some(text => text.includes('Gemini Models')));
});
test('exhausted weekly and five-hour buckets preserve their distinct reset times', () => {
  const quota = quotaSnapshot(data(0, 0));
  assert(quota.warnings.some(text => text.includes('2050-10-13T14:27:34Z')));
  assert(quota.warnings.some(text => text.includes('2050-10-08T14:09:09Z'))); assert(quota.warnings.every(text => text.includes('credits')));
});
test('unknown quota is never invented as zero and invalid fractions are rejected', () => {
  const quota = quotaSnapshot(data(null));
  assert.equal(quota.groups[0].buckets[0].remaining_fraction, null);
  assert(!quota.warnings.some(text => text.includes('Gemini Models')));
  assert.throws(() => quotaSnapshot(data(-1)));
});
test('native read-only quota result supports Chinese chunks and zero conversation without relaxing task results', () => {
  const command = { name: 'usage', data: data() }, quota = new CliEventParser(undefined, undefined, 'usage');
  const bytes = Buffer.from(JSON.stringify({ event: 'command_result', command }) + '\n' + JSON.stringify({ event: 'result', result: {
    status: 'SUCCESS', response: '原生额度', conversation_id: '', command
  } }) + '\n');
  for (let index = 0; index < bytes.length; index += 3) quota.push(bytes.subarray(index, index + 3));
  assert.equal(quota.finish()?.command?.name, 'usage'); assert.equal(quota.envelope?.conversation_id, undefined);
  const task = new CliEventParser(); task.push(bytes); assert.equal(task.finish(), undefined); assert(task.protocolError);
  const invalid = new CliEventParser(undefined, undefined, 'usage');
  invalid.push(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'model guessed quota', conversation_id: '' } }));
  assert.equal(invalid.finish(), undefined);
});
test('only explicit exhaustion errors are classified and quota failure requests the user decision', () => {
  for (const text of ['Quota exhausted until refresh', 'Insufficient AI credits', '配额已耗尽']) assert.equal(isQuotaExhaustion(text), true);
  for (const text of ['HTTP 429: Too many requests', 'RESOURCE_EXHAUSTED', 'Quota exceeded: requests per minute', 'Permission denied', 'API capacity exhausted', 'Quota is not exhausted; authentication required', 'No quota error, exhausted retries due to network', '配额未耗尽']) assert.equal(isQuotaExhaustion(text), false);
  const result = normalizeResult({ status: 'ERROR', executionStatus: 'CLI_QUOTA_EXHAUSTED', errorCode: 'CLI_QUOTA_EXHAUSTED' });
  assert.equal(result.failureStage, 'CLI'); assert.match(result.nextAction!, /请用户选择/); assert.match(result.nextAction!, /等待额度恢复/);
  assert(!('quota' in normalizeResult({ status: 'SUCCESS', executionStatus: 'SUCCESS' })));
});
