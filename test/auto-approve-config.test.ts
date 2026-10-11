import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 配置在模块加载时读取，所以先写配置再导入执行器。
const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'agy-approve-'));
const config = path.join(root, 'config.json');
fs.writeFileSync(config, JSON.stringify({ defaultModel: 'gemini-3.8-flash-high', defaultEffort: 'high', defaultAutoApprove: false }));
process.env.ANTIGRAVITY_CONFIG_PATH = config; process.env.ANTIGRAVITY_MCP_STATE_HOME = path.join(root, 'state');
const { executeAgy } = await import('../src/agy-executor.js');
const { taskTracker } = await import('../src/utils/task-tracker.js');
const { ConfigManager } = await import('../src/utils/config-manager.js');
const { createAntigravityServer } = await import('../src/server.js');
const { requestedAutoApprove } = await import('../src/tools/task-input.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const cli = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
test.after(async () => { await taskTracker.shutdownAll(); fs.rmSync(root, { recursive: true, force: true }); });

const workspace = (name: string) => { const directory = path.join(root, name); fs.mkdirSync(directory, { recursive: true }); return directory; };
const capturedArgs = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')).args as string[];

test('defaultAutoApprove is optional, defaults to true and must be boolean', () => {
  const file = path.join(root, 'variants.json');
  fs.writeFileSync(file, JSON.stringify({ defaultModel: 'gemini-3.8-flash-high', defaultEffort: 'high' }));
  assert(!('defaultAutoApprove' in new ConfigManager(file).getConfig()));
  fs.writeFileSync(file, JSON.stringify({ defaultModel: 'gemini-3.8-flash-high', defaultEffort: 'high', defaultAutoApprove: false }));
  assert.equal(new ConfigManager(file).getConfig().defaultAutoApprove, false);
  fs.writeFileSync(file, JSON.stringify({ defaultModel: 'gemini-3.8-flash-high', defaultEffort: 'high', defaultAutoApprove: 'false' }));
  assert.throws(() => new ConfigManager(file), /INVALID_CONFIG/);
});

test('an omitted approval uses the configured default; an explicit value wins', async () => {
  const omitted = workspace('omitted'), capture = path.join(root, 'omitted.json');
  const defaulted = await executeAgy({ prompt: 'FIXTURE:' + JSON.stringify({ capture }), workspaceDir: omitted, cliPath: process.execPath, cliArgsPrefix: [cli], requestWaitTimeoutMs: 20000 });
  assert.equal(defaulted.status, 'SUCCESS'); assert.equal(defaulted.autoApprove, false);
  assert(!capturedArgs(capture).includes('--dangerously-skip-permissions'));
  const explicitCapture = path.join(root, 'explicit.json');
  const explicit = await executeAgy({ prompt: 'FIXTURE:' + JSON.stringify({ capture: explicitCapture }), workspaceDir: workspace('explicit'), autoApprove: true,
    cliPath: process.execPath, cliArgsPrefix: [cli], requestWaitTimeoutMs: 20000 });
  assert.equal(explicit.autoApprove, true); assert(capturedArgs(explicitCapture).includes('--dangerously-skip-permissions'));
});

test('MCP keeps the advertised default and distinguishes omitted from explicit auto_approve', async () => {
  const server = createAntigravityServer(), client = new Client({ name: 'approval', version: '3' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    for (const tool of (await client.listTools()).tools.filter(item => ['antigravity_ask', 'antigravity_code'].includes(item.name))) {
      assert.equal((tool.inputSchema.properties?.auto_approve as { default?: boolean }).default, true);
    }
  } finally { await client.close(); await server.close(); }
  // schema 默认值填入的 true 不能覆盖配置；只有原始请求里出现的字段才算显式传值。
  assert.equal(requestedAutoApprove({ auto_approve: true }, { prompt: 'x' }), undefined);
  assert.equal(requestedAutoApprove({ auto_approve: true }, { prompt: 'x', auto_approve: true }), true);
  assert.equal(requestedAutoApprove({ auto_approve: false }, { prompt: 'x', auto_approve: false }), false);
  assert.equal(requestedAutoApprove({ auto_approve: true }, undefined), undefined);
});
