import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { TaskResult, TaskSummary } from '../src/utils/register-tool.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const execute = (command: string, args: string[], cwd: string) => execFileSync(command, args, {
  cwd, encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 16 * 1024 * 1024,
});
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 30000;
  while (!await predicate()) {
    assert(Date.now() < deadline, '包装验收等待超时');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

test('Windows plugin ZIP relocates with metadata, production dependencies and original Skill', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agy 插件 包装-'));
  t.after(() => {
    const resolved = fs.realpathSync(temporary);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('agy 插件 包装-'));
    const noLinks = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        assert(!fs.lstatSync(target).isSymbolicLink());
        if (entry.isDirectory()) noLinks(target);
      }
    };
    noLinks(resolved); fs.rmSync(resolved, { recursive: true, force: true });
  });
  const release = path.join(temporary, '发布 空格');
  const packed = JSON.parse(execute(process.execPath, ['scripts/package-plugin.mjs', '--output-dir', release], root));
  const listing = execute(tar, ['-tf', packed.zip], temporary).trim().split(/\r?\n/);
  const name = 'antigravity-mcp-plugin-2.0.0';
  assert(listing.includes(`${name}/.agents/plugins/marketplace.json`));
  assert(listing.includes(`${name}/plugins/antigravity-mcp/runtime/dist/task-worker.js`));
  assert(listing.every(entry => entry.startsWith(name + '/')));
  // 仅运行代码与依赖可进入 runtime，不夹带开发源码、用户状态或诊断目录。
  const prefix = `${name}/plugins/antigravity-mcp/runtime/`;
  for (const entry of listing.filter(entry => entry.startsWith(prefix) && entry !== prefix)) {
    assert(['package.json', 'config.json', 'dist', 'node_modules'].includes(entry.slice(prefix.length).split('/')[0]), entry);
  }
  for (const dev of ['tsx', 'typescript', 'esbuild', '@esbuild']) {
    assert(!listing.some(entry => entry.startsWith(`${prefix}node_modules/${dev}/`)), dev);
  }
  assert(!listing.some(entry => /\/(audit|\.verify-out|\.gemini|\.codegraph|logs|\.env)(\/|$)/.test(entry)));
  const relocated = path.join(temporary, '解压 中文'); fs.mkdirSync(relocated);
  execute(tar, ['-xf', packed.zip, '-C', relocated], temporary);
  const directory = path.join(relocated, name), plugin = path.join(directory, 'plugins/antigravity-mcp');
  const marketplace = read(path.join(directory, '.agents/plugins/marketplace.json'));
  const manifest = read(path.join(plugin, 'plugin.json'));
  assert.equal(path.resolve(directory, marketplace.plugins[0].source.path), plugin);
  assert.equal(manifest.name, 'antigravity-mcp'); assert.equal(manifest.version, '2.0.0');
  assert.equal(manifest.extensions['com.openai'].interface.displayName, 'Antigravity MCP');
  assert.deepEqual(fs.readFileSync(path.join(plugin, 'skills/antigravity-delegation/SKILL.md')),
    fs.readFileSync(path.join(root, 'plugin/skills/antigravity-delegation/SKILL.md')));
  assert.deepEqual(read(path.join(plugin, 'runtime/config.json')), read(path.join(root, 'config.json')));
  for (const dependency of ['@modelcontextprotocol/sdk', 'zod']) {
    const target = path.join(plugin, 'runtime/node_modules', dependency);
    assert(fs.existsSync(path.join(target, 'package.json')));
    assert(fs.readdirSync(target).some(file => /^licen[cs]e/i.test(file)), `${dependency} license`);
  }
  assert.equal(read(path.join(plugin, 'runtime/package.json')).engines.node, '>=20');
  assert(!fs.readdirSync(release).some(entry => entry.startsWith('.plugin-build-')));

  await t.test('relocated MCP executes, resumes, reconnects and cancels without source/global runtime', { timeout: 90000 }, async () => {
    const fakeDirectory = path.join(temporary, '假 CLI'); fs.mkdirSync(fakeDirectory);
    for (const file of ['fake-agy.mjs', 'fake-agy-launcher.mjs', 'fake-agy-launcher.cs']) {
      fs.copyFileSync(path.join(root, 'test/fixtures', file), path.join(fakeDirectory, file));
    }
    const executable = path.join(fakeDirectory, 'fake-agy.exe');
    const compiler = path.join(fakeDirectory, 'compile.ps1');
    fs.writeFileSync(compiler, '$ErrorActionPreference="Stop"; Add-Type -Path $args[0] -OutputAssembly $args[1] -OutputType ConsoleApplication');
    execute(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-File', compiler, path.join(fakeDirectory, 'fake-agy-launcher.cs'), executable], temporary);
    const home = path.join(temporary, '用户 状态'), workspace = path.join(temporary, '项目 中文');
    fs.mkdirSync(home); fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'source');
    const starts = path.join(temporary, 'starts.txt');
    const server = read(path.join(plugin, 'mcp.json')).mcpServers['antigravity-mcp'];
    assert.equal(server.command, 'node'); assert.equal(server.type, 'stdio');
    assert.deepEqual(server.args, ['${PLUGIN_ROOT}/runtime/dist/index.js']);
    const connect = async () => {
      const client = new Client({ name: 'relocated-plugin-test', version: '1' });
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        TEMP: temporary, TMP: temporary, USERPROFILE: home, ANTIGRAVITY_MCP_STATE_HOME: home,
        AGY_PATH: executable, PLUGIN_TEST_NODE: process.execPath,
        PLUGIN_TEST_FAKE_SCRIPT: path.join(fakeDirectory, 'fake-agy-launcher.mjs'), TEST_MODEL_STARTS: starts,
      };
      const transport = new StdioClientTransport({ command: process.execPath,
        args: server.args.map((arg: string) => arg.replaceAll('${PLUGIN_ROOT}', plugin)), cwd: plugin, env, stderr: 'pipe' });
      let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
      try { await client.connect(transport); } catch (error) { await client.close(); throw new Error(`${error}: ${stderr}`); }
      return client;
    };
    const data = (result: unknown): TaskResult & Partial<TaskSummary> => {
      const response = result as { content: { text: string }[]; structuredContent: Record<string, unknown> };
      assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
      return (response.structuredContent.kind === 'task' ? response.structuredContent.data : response.structuredContent) as TaskResult & Partial<TaskSummary>;
    };
    const prompt = (options: unknown) => 'FIXTURE:' + JSON.stringify(options);
    const call = (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    let client = await connect(); let activeId: string | undefined;
    try {
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(),
        ['antigravity_ask', 'antigravity_code', 'antigravity_status', 'antigravity_cancel_task'].sort());
      const ask = data(await call(client, 'antigravity_ask', { prompt: prompt({ response: '中文答案' }), workspace_dir: workspace }));
      assert.equal(ask.status, 'SUCCESS', JSON.stringify(ask)); assert.equal(ask.response, '中文答案');
      assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'source');
      const code = data(await call(client, 'antigravity_code', {
        prompt: prompt({ writes: { 'a.txt': 'generated' }, response: '已完成编码' }), workspace_dir: workspace,
      }));
      assert.equal(code.status, 'SUCCESS', JSON.stringify(code)); assert(code.conversationId);
      assert.equal(code.model, 'gemini-3.8-flash-high'); assert.equal(code.effort, 'high'); assert.equal(code.autoApprove, true);
      assert.equal(code.rawLog, null); assert.deepEqual(code.usage, { input_tokens: 12, output_tokens: 4 });
      assert.equal(code.executionWorkspaceDir, workspace);
      const resumed = data(await call(client, 'antigravity_ask', {
        prompt: prompt({ response: '续接完成' }), workspace_dir: workspace, conversation_id: code.conversationId,
      }));
      assert.equal(resumed.status, 'SUCCESS'); assert.equal(resumed.conversationId, code.conversationId);
      assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'generated');
      const active = data(await call(client, 'antigravity_code', {
        prompt: prompt({ hang: true, descendants: true, writes: { 'kept.txt': '保留改动' } }), workspace_dir: workspace, async_mode: true,
      }));
      activeId = active.taskId!; assert.equal(active.status, 'RUNNING');
      await until(() => fs.existsSync(path.join(workspace, 'descendant.pid')));
      const childPid = Number(fs.readFileSync(path.join(workspace, 'descendant.pid'), 'utf8'));
      await client.close(); client = await connect();
      const recovered = data(await call(client, 'antigravity_status', { task_id: activeId }));
      assert.equal(recovered.status, 'RUNNING'); assert(recovered.conversationId);
      const quiet = data(await call(client, 'antigravity_status', { task_id: activeId, after_revision: recovered.revision, view: 'summary' }));
      assert.equal(quiet.status, 'RUNNING'); assert.equal(quiet.summary, true);
      const cancelled = data(await call(client, 'antigravity_cancel_task', { task_id: activeId }));
      assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.managedProcess, 'EXITED');
      assert.throws(() => process.kill(childPid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
      assert.equal(fs.readFileSync(path.join(workspace, 'kept.txt'), 'utf8'), '保留改动');
      const complete = data(await call(client, 'antigravity_status', { task_id: code.taskId! }));
      assert.equal(complete.response, code.response); assert.equal(complete.status, 'SUCCESS');
      assert.equal(fs.readFileSync(starts, 'utf8').trim().split('\n').length, 4, '重连和查询不重跑模型');
      assert(fs.readdirSync(path.join(home, '.gemini/antigravity-mcp-jobs-v1')).some(file => file.endsWith('.task.json')));
      assert.deepEqual(fs.readdirSync(plugin).sort(), ['mcp.json', 'plugin.json', 'runtime', 'skills']);
      assert.deepEqual(fs.readdirSync(workspace).sort(), ['a.txt', 'descendant.pid', 'kept.txt']);
    } finally {
      if (activeId) await call(client, 'antigravity_cancel_task', { task_id: activeId });
      await client.close();
    }
  });
});
