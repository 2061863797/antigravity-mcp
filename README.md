# Antigravity MCP

把本机的 Antigravity CLI（`agy`）包装成标准 MCP 服务，让任意支持 MCP 的 agent（Codex、Claude Code、Cursor 等）把分析、编码和复核任务委派给 agy。

- **MCP 负责**：启动 agy、汇报进度和结果、管理后台任务、停止进程。
- **调用方 agent 负责**：检查文件改动、运行测试、验收成果。

直接调用本机 agy，不调用 Gemini API，不保存账号凭据。

**版本 2.0.0 · 结果协议 schemaVersion 3 · 传输方式：本地 stdio**

## 提供的工具

| 工具 | 用途 |
| --- | --- |
| `antigravity_ask` | 问答、分析、调研、代码审核 |
| `antigravity_code` | 在指定目录完成编码 |
| `antigravity_status` | 带 `task_id`：查询任务进度和结果；不带：查询 agy 原生额度 |
| `antigravity_cancel_task` | 停止任务及其所有子进程，保留已有文件改动 |

## 快速开始

### 1. 准备环境

- Node.js 20 或更高版本。
- agy CLI 1.1.15 或更高版本，已按 [官方文档](https://antigravity.google/docs/cli/headless/) 安装并登录。

```powershell
node --version
agy --version
```

本服务不负责安装 agy，也不代替登录。

### 2. 下载并构建

```powershell
git clone https://github.com/2061863797/antigravity-mcp.git
cd antigravity-mcp
npm ci
npm run build
```

构建产物是 `dist/index.js`，由 MCP 客户端按需启动。不需要全局安装，也不要用 `npm start` 常驻运行。

### 3. 自检

```powershell
node dist/index.js --doctor
```

输出 JSON；全部通过时退出码为 0，任一项失败时为 1。只运行一次 `agy --version`，不调用模型，也不创建任务。

| 检查项 | 内容 |
| --- | --- |
| `agy` | 能否找到 agy，版本是否满足最低要求 |
| `config` | 配置文件能否读取，打印默认模型、推理强度和自动审批设置 |
| `stateDir` | 状态目录能否写入 |
| `powershell` | 仅 Windows：语言模式是否为 `FullLanguage`（受限模式下无法启动任务） |

如果客户端配置里设置了环境变量（如 `AGY_PATH`），自检时也要带上同样的变量，结果才有参考价值。

### 4. 接入 MCP 客户端

任何支持 stdio 的客户端都按同一方式配置：命令为 `node`，参数为 `dist/index.js` 的**绝对路径**。把下面示例中的路径换成你的实际位置。

大多数客户端使用 JSON 格式（配置文件位置以各客户端文档为准）：

```json
{
  "mcpServers": {
    "antigravity": {
      "command": "node",
      "args": ["C:/Projects/antigravity-mcp/dist/index.js"],
      "env": { "AGY_PATH": "C:/Tools/agy/agy.exe" }
    }
  }
}
```

使用 TOML 的客户端（如 Codex 的 `config.toml`）：

```toml
[mcp_servers.antigravity]
command = "node"
args = ["C:/Projects/antigravity-mcp/dist/index.js"]

[mcp_servers.antigravity.env]
AGY_PATH = "C:/Tools/agy/agy.exe"
```

能从 PATH 或默认安装位置找到 agy 时，`env` 可以省略。配置后重新连接 MCP，确认能看到四个工具。同一个服务不要重复添加。

### 另一种方式：Codex / Claude Code 插件（Windows）

插件包自带运行时、依赖和协作 Skill，不需要保留源码仓库。在仓库目录生成插件包：

```powershell
npm run package:plugin
```

产物在 `release/` 下。把 ZIP 解压到长期保留的目录，然后在解压目录中运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会自动安装到本机已有的 Codex 和 Claude Code。参数、手动安装、升级和卸载方法见 [插件说明](plugin/README.md)。插件和上面的手动配置二选一，不要同时使用。

## 使用示例

下面是工具调用的参数，实际由 agent 提交。

### 分析或审核

```json
{
  "name": "antigravity_ask",
  "arguments": {
    "prompt": "审核保存流程，说明问题的触发条件、调用路径和复现方法。不要修改文件。",
    "workspace_dir": "C:/Projects/example"
  }
}
```

### 后台编码

```json
{
  "name": "antigravity_code",
  "arguments": {
    "prompt": "修复 src/sum.ts 的输入校验，只改相关文件，不安装依赖。完成后说明改动和未验证范围。",
    "workspace_dir": "C:/Projects/example",
    "async_mode": true
  }
}
```

返回结果里有 `taskId`，之后用它查询或取消。

### 查询进度（长轮询）

```json
{
  "name": "antigravity_status",
  "arguments": { "task_id": "task_...", "after_revision": 12, "wait_ms": 60000, "view": "summary" }
}
```

把上次结果中的 `revision` 填进 `after_revision`：有变化时立即返回，没有变化最多等 `wait_ms` 毫秒。`summary` 视图只返回简报，任务结束时自动返回完整结果。需要再次读取完整结果时，去掉 `after_revision` 和 `view` 即可。

### 取消

```json
{ "name": "antigravity_cancel_task", "arguments": { "task_id": "task_..." } }
```

### 续接会话

```json
{
  "name": "antigravity_code",
  "arguments": {
    "prompt": "基于现有成果完成剩余输入校验，不重复已完成的修改。",
    "workspace_dir": "C:/Projects/example",
    "conversation_id": "上次结果中的 conversationId"
  }
}
```

`taskId` 标识一次执行，用于查询和取消；`conversationId` 标识一次对话，用于续接。续接必须使用原来的工作目录，并先确认旧任务已经停止。

### 查询额度

```json
{ "name": "antigravity_status", "arguments": {} }
```

返回各模型组的剩余比例和重置时间。不启动模型，也不创建任务。查询失败表示额度未知，不代表额度为零。

## 参数

`antigravity_ask` 和 `antigravity_code` 必填 `prompt`（最多 24,000 字符），以及 `workspace_dir`（已存在目录的绝对路径）。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `context` | 无 | 补充上下文，最多 20,000 字符 |
| `model` | 配置的默认模型 | 指定的模型不可用时直接失败，不自动替换 |
| `effort` | 配置的默认强度 | `low` / `medium` / `high` / `xhigh` / `max` |
| `cli_mode` | `accept-edits` | 需要规划流程时传 `plan` |
| `auto_approve` | `true` | 自动批准命令和文件写入；`false` 时遵循本机 agy 的权限配置 |
| `async_mode` | `false` | `true` 时立即返回 `taskId` |
| `timeout_minutes` | 不限 | 只限制同步等待时长；到期返回 `taskId`，任务继续运行 |
| `execution_timeout_minutes` | 不限 | 限制任务本身的执行时长；到期停止任务 |
| `conversation_id` | 无 | 续接已有会话 |
| `debug_log` | `false` | 保存最多 5 MiB 原始输出，用于排错 |

两个时长参数的范围都是大于 0 分钟、不超过 1440 分钟。Windows 上，转义后的整条命令行不能超过 30,000 字符。

**同步还是异步？** 后续工作依赖 agy 的结果、且没有别的事可做时，用同步；有独立工作可以并行推进时，用异步。客户端对单次请求通常有自己的超时：预计会超时就先用异步拿到 `taskId`。请求超时不等于任务停止，不要重复提交。

## 配置

### config.json

仓库自带的 [config.json](config.json) 只包含前两项，完整写法如下：

```json
{
  "defaultModel": "gemini-3.8-flash-high",
  "defaultEffort": "high",
  "defaultAutoApprove": true
}
```

- `defaultModel`、`defaultEffort`：调用方不指定时使用。默认模型必须在你的 agy 账号中可用。
- `defaultAutoApprove`：可选，调用方省略 `auto_approve` 时使用，不写等同于 `true`。
- 优先级：调用时显式传入的值 → 续接会话保存的值（仅模型和强度） → 配置文件 → 内置默认值。

建议把自定义配置放在仓库之外，用 `ANTIGRAVITY_CONFIG_PATH` 指定，这样更新代码时不会冲突。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `AGY_PATH` | agy 可执行文件的路径；不设置时依次查找 PATH 和 Windows 默认安装目录 |
| `ANTIGRAVITY_CONFIG_PATH` | 配置文件的绝对路径 |
| `ANTIGRAVITY_MCP_STATE_HOME` | 状态目录的上级目录，默认为用户主目录 |
| `ANTIGRAVITY_SKIP_VERSION_CHECK` | 设为 `1` 时跳过 agy 版本预检（仅在确认兼容时使用） |
| `DEBUG` | 设为 `1` 时向 stderr 输出调试日志 |

## 结果与进度

- 任务状态共五种：`RUNNING`、`SUCCESS`、`ERROR`、`CANCELLED`、`TIMEOUT`。
- **`SUCCESS` 只表示 agy 调用成功，不代表成果正确。** 调用方仍需检查改动并运行测试。
- 失败时结果附带 `errorCode`、`failureStage`、`errorMessage` 和建议操作 `nextAction`，已取得的响应和会话都会保留。
- 运行中的结果显示当前阶段、正在使用的工具、文件和命令、最近 5 次工具操作，以及模型输出的最新片段（`latestText`）。完整回答在 `response` 中。
- 同步调用时，如果客户端请求了进度通知，服务会在阶段变化时发送，并每 60 秒重复发送一次（消息含 `taskId` 和已用时间）。客户端中断等待时，可以用这个 `taskId` 继续查询。
- `antigravity_status` 返回 `{ "schemaVersion": 3, "kind": "task" | "quota", "data": ... }`，另外三个工具直接返回任务结果。

## 安全与运行边界

- **默认自动审批**：agy 执行命令和写文件不再逐项确认（相当于 agy 的 `--dangerously-skip-permissions`，同时启用 `--sandbox`）。需要逐项确认时传 `auto_approve: false`，或在配置中设置 `defaultAutoApprove: false`。
- **`ask` 不是只读保护**：它只靠提示词要求 agent 不改文件。工作目录是 git 仓库时，结果会附带 `workspaceChanged`；有变化时，`workspaceChangeSummary` 列出最多 20 个路径。这只说明运行期间工作区有变化，不能确定是 agent 改的（你或编辑器也可能同时在改）。这项检查不拦截也不回滚。
- **直接在真实目录执行**：同一目录及其父子目录同一时间只能跑一个任务，不同目录可以并行。这种互斥不阻止其他软件修改文件。
- **禁止作为工作目录**：磁盘根目录、用户主目录本身（子目录可以）、Windows 系统目录和 Program Files，以及 POSIX 的 `/etc`、`/usr`、`/bin`、`/sbin`、`/lib`、`/var`、`/System`、`/Library`、`/private`（系统临时目录除外）。判断基于真实路径，符号链接无法绕过。
- **失败也保留改动**：失败、取消和超时都不回滚文件。确认进程全部停止后才解除目录占用；无法确认时会明确报告，可以再次取消。
- **任务独立于客户端**：任务由独立的 worker 进程执行，客户端断开或重启后，仍能用原 `taskId` 查询和取消。电脑重启后任务不会自动恢复。
- **进程清理**：
  - Windows：用 Job Object 清理整个进程树，并核对进程身份，避免误杀复用了同一 PID 的进程。
  - Linux/macOS：先发 SIGTERM，宽限 5 秒后再强制结束。
  - 只有 Linux 能找回已脱离进程树的后代进程；按完整环境变量条目匹配本任务的清理令牌，其他变量名或变量值中的相同文本不会被选中。worker 本身崩溃后的自动清理只在 Windows 上支持。
- **识别假成功**：agy 退出时如果终止了仍在运行的后台命令，结果标为 `CLI_BACKGROUND_ABORTED`，并把已有回答作为部分结果保留。

**不提供的功能**：HTTP/SSE 传输、工作区隔离或备份、自动回滚、自动重试、自动换模型、异步任务完成后主动唤醒 agent、运行中回答 agy 的交互提问。

## 数据存放位置

所有状态都在用户主目录下的 `.gemini/` 中（可用 `ANTIGRAVITY_MCP_STATE_HOME` 修改），不会写进你的项目：

| 目录 | 内容 |
| --- | --- |
| `antigravity-mcp-jobs-v1/` | 任务记录和完整结果；运行中的任务全部保留，已完成的保留最近 100 个 |
| `antigravity-mcp-conversations-v3/` | 会话与工作目录的绑定关系 |
| `antigravity-mcp-leases/` | 目录占用记录 |
| `antigravity-mcp-logs/` | 开启 `debug_log` 时的原始输出 |
| `antigravity-mcp-bin/` | Windows 任务启动脚本（自动生成，内容校验后才使用） |

## 常见问题

| 现象 / 错误码 | 处理 |
| --- | --- |
| `AGY_NOT_FOUND` | 安装 agy，或用 `AGY_PATH` 指向它的可执行文件 |
| `AGY_VERSION_UNSUPPORTED` | 把 agy 升级到 1.1.15 或更高版本 |
| `AGY_VERSION_UNREADABLE` | 检查 `agy --version` 能否正常输出；确认兼容后可设置 `ANTIGRAVITY_SKIP_VERSION_CHECK=1` |
| `WORKSPACE_BUSY` | 该目录（或其父子目录）已有任务在运行，等它结束或先取消 |
| `PROCESS_TERMINATION_UNCONFIRMED` | 无法确认进程已停止，再次调用取消；确认停止前不要重新提交 |
| `CLI_QUOTA_EXHAUSTED` | 额度用完，等额度恢复后用原会话续接，或改由 agent 自己完成 |
| `CLI_BACKGROUND_ABORTED` | 让 agent 在前台运行验证命令，不要用后台命令 |
| `TASK_NOT_FOUND` | 核对 `taskId`；已完成的记录只保留最近 100 个 |
| 请求超时但任务仍在运行 | 用 `taskId` 查询，不要重复提交 |
| `--doctor` 提示 PowerShell 不是 `FullLanguage` | 系统策略限制了 PowerShell，需要管理员调整 AppLocker/WDAC 策略 |

## 更新

先等活动任务结束或将其取消，然后在仓库目录执行：

```powershell
git pull --ff-only
npm ci
npm run build
```

更新后重新连接 MCP。已经在运行的进程不会自动加载新版本；更新不会删除或重跑已有任务。

## 开发

```powershell
npm ci
npm run check
```

`check` 依次执行构建、测试代码类型检查和全部回归测试。测试使用假的 agy，不调用真实模型。Windows 是主要验证平台，部分仅适用于 POSIX 的用例在 Windows 上会跳过。

`scripts/` 下有两个需要真实 agy 的脚本，会消耗模型额度，只能在设置 `ANTIGRAVITY_LIVE_TESTS=1` 后手动运行：

- `live-cli-compat.mjs`：端到端兼容性验收。
- `live-print-timeout.mjs`：`--print-timeout` 取值实验。

协作规范 Skill 位于 [`plugin/skills/antigravity-delegation/SKILL.md`](plugin/skills/antigravity-delegation/SKILL.md)。

## 许可证

[MIT](LICENSE)。本项目是独立工具，不隶属于 Google、OpenAI 或 Antigravity。
