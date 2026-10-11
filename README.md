# Antigravity MCP

通过 MCP 调用本机 Antigravity CLI（`agy`），让 Codex 等父 agent 委派分析、编码和复核任务。

MCP 负责启动 agy、交付进度与结果、管理后台任务和停止进程；父 agent 负责检查文件、运行测试与验收成果。项目直接使用 agy，不调用独立的 Gemini API。

**包版本：2.0.0 · 结果协议：schemaVersion 3 · 传输：本地 stdio**

## 功能

| 工具 | 用途 |
| --- | --- |
| `antigravity_ask` | 问答、分析、调研和代码审核 |
| `antigravity_code` | 在指定工作目录完成编码任务 |
| `antigravity_status` | 带任务 ID 查询进度与结果；不带任务 ID 查询原生额度 |
| `antigravity_cancel_task` | 停止任务及子进程，保留已有文件改动 |

- 支持同步等待和独立后台任务，客户端重连后可查询原任务。
- 支持显式会话续接、执行期限和同目录及父子目录互斥。
- 展示当前工具、文件、命令、最近五次工具操作和当前模型响应片段。
- 保留完整最终响应、上游错误和原始用量；调试日志按需开启。
- Windows 进程管理核对 PID 与创建标识，停止确认前不释放目录占用。

不提供 HTTP/SSE、工作区隔离、备份、自动回滚、自动重试、模型切换或异步完成后自动唤醒。运行中不能通过 MCP 回答 agy 的交互问题。

## 环境要求

- **Node.js 20+** 和 npm。
- 已安装并登录的 **agy CLI**，支持官方 `stream-json` 输出。
- 支持本地 stdio 的 MCP 客户端，例如 Codex。
- Windows 是主要验证平台；Windows worker 需要 PowerShell 和 CIM/WMI 可用。其他平台未完成同等实机验收。

先确认以下命令可用，并按 [agy 官方文档](https://antigravity.google/docs/cli/headless/)完成安装与登录：

```powershell
node --version
agy --version
```

MCP 不安装 agy、不代替登录，也不包含账号凭据。

## 安装与接入

### 1. 获取并构建

```powershell
git clone https://github.com/2061863797/antigravity-mcp.git
cd antigravity-mcp
npm ci
npm run build
```

此仓库按源码分发，不需要全局安装 `antigravity-mcp`。构建后由 MCP 客户端启动 `dist/index.js`；不要把 `npm start` 当成常驻 HTTP 服务。

### 2. 配置 Codex

假设仓库位于 `C:\Projects\antigravity-mcp`，可以通过 Codex CLI 添加：

```powershell
codex mcp add antigravity -- node "C:\Projects\antigravity-mcp\dist\index.js"
```

也可以在 Codex 的 `config.toml` 中配置，路径须替换为自己的实际位置：

```toml
[mcp_servers.antigravity]
command = "node"
args = ["C:/Projects/antigravity-mcp/dist/index.js"]
```

不要同时重复添加同一个服务。配置后重新连接 MCP，确认四个工具可见。客户端命令和配置格式参见 [Codex MCP 官方说明](https://developers.openai.com/codex/mcp/)。

其他支持 stdio 的客户端可参考 [JSON 配置示例](chatgpt_desktop_config.example.json)。

### 3. 指定 agy 路径（可选）

MCP 按 `AGY_PATH`、PATH 和 Windows 标准安装目录查找 CLI。需要显式指定时，在客户端的 MCP 环境配置中设置：

```toml
[mcp_servers.antigravity.env]
AGY_PATH = "C:/Tools/agy/agy.exe"
```

`AGY_PATH` 必须指向实际可执行文件；路径错误会直接失败，不换用其他后端。

## 使用示例

以下是 MCP 工具调用参数；实际由父 agent 或客户端提交。

### 分析或审核

```json
{
  "name": "antigravity_ask",
  "arguments": {
    "prompt": "审核保存流程，说明确定问题的触发条件、调用路径和复现方法。不要修改文件。",
    "workspace_dir": "C:/Projects/example"
  }
}
```

`ask` 默认通过任务指令要求只分析、不写文件，**不是系统级只读保护**。`ask` 和 `code` 均默认使用 `accept-edits`；只有明确需要规划时才传 `cli_mode: "plan"`。规划模式不是通用只读开关。

### 后台编码

```json
{
  "name": "antigravity_code",
  "arguments": {
    "prompt": "修复 src/sum.ts 的输入校验，只修改相关文件，不安装依赖。完成后说明改动和未验证范围。",
    "workspace_dir": "C:/Projects/example",
    "async_mode": true
  }
}
```

保存返回的 `taskId`。父 agent 有独立工作可推进时使用异步；后续依赖 agy 结果且没有独立工作时使用同步。执行方式由调用方决定，MCP 不猜测提示词。

### 查询进度与完整结果

```json
{
  "name": "antigravity_status",
  "arguments": {
    "task_id": "task_...",
    "after_revision": 12,
    "wait_ms": 60000,
    "view": "summary"
  }
}
```

使用上次返回的 `revision` 作为 `after_revision`。无变化时简报只包含任务 ID、状态、版本和 `unchanged`；新终态直接返回完整结果。重要的停止或身份诊断不会被隐藏。需要重新获取完整结果时，省略游标并使用默认 `full` 视图。

`antigravity_status` 返回 `{ "schemaVersion": 3, "kind": "task" | "quota", "data": ... }`。其他三个工具直接返回任务结果；JSON 文本与 `structuredContent` 一致。

### 取消和续接

```json
{
  "name": "antigravity_cancel_task",
  "arguments": { "task_id": "task_..." }
}
```

取消、执行超时和失败均保留文件改动。确认进程树停止后才释放目录；未确认时保留占用并明确报告，可重试取消。重复取消已完成任务不改变结果。

POSIX 上对已逃逸后代的清理仅 Linux 支持：任务环境中的随机标记随子进程继承，清理时通过 `/proc` 查找脱离原父子关系的后代。macOS 等没有 Linux `/proc` 的平台只枚举当前父子关系；Windows 沿用 Job Object 和进程身份校验。

worker 意外崩溃后的自动后代清理目前仅 Windows 支持。POSIX 没有对应的 worker 退出监视，不能保证崩溃时停止已分离的后代；只要仍有存活进程，任务会保留目录占用并报告停止未确认。

续接时传回 `conversationId`，仍使用原实际工作目录：

```json
{
  "name": "antigravity_code",
  "arguments": {
    "prompt": "基于现有成果完成剩余输入校验，不重复已经完成的修改。",
    "workspace_dir": "C:/Projects/example",
    "conversation_id": "原 conversationId",
    "async_mode": true
  }
}
```

`taskId` 标识一次执行，用于查询和取消；`conversationId` 标识对话，用于显式续接。先确认旧进程停止并检查已有成果。目录缺失、绑定不符或仍被占用时拒绝续接；不会自动新建会话或重跑。

### 查询额度

```json
{ "name": "antigravity_status", "arguments": {} }
```

执行原生 `/usage`，返回全部模型组、各限制的剩余比例、重置时间、读取时间与低额度提醒。未知值保留 null，查询失败不当成零额度。此查询不启动模型、不创建任务或会话、不占用项目目录，也不覆盖任务结果。

不带任务 ID 时不能传 `view`、`after_revision` 或 `wait_ms`。任务执行前后不会自动查询额度。只有上游明确额度耗尽才返回 `CLI_QUOTA_EXHAUSTED`；调用方应让用户选择接手或等待恢复，不自动换模型、重试、切账号或调整计费。

## 参数与默认配置

`ask` / `code` 必须提供 `prompt` 和已存在目录的绝对路径 `workspace_dir`。

| 参数 | 默认值 / 限制 | 说明 |
| --- | --- | --- |
| `context` | 可选，最多 20,000 字符 | 必要上下文、修改范围和验收要求 |
| `model` | 配置默认值 | 用户指定优先，不自动切换 |
| `effort` | 配置默认值 | 接受 low、medium、high、xhigh、max；CLI 不支持时失败 |
| `cli_mode` | `accept-edits` | 明确规划时选择 `plan` |
| `auto_approve` | `true` | 原生自动审批；false 遵循本机 agy 权限配置 |
| `async_mode` | `false` | true 返回任务 ID，之后查询 |
| `timeout_minutes` | 不设置 | 只限制同步等待；到期后台任务继续 |
| `execution_timeout_minutes` | 不设置 | 限制准备和 agy 执行；到期停止任务 |
| `conversation_id` | 不设置 | 显式续接原目录会话；省略则新会话 |
| `debug_log` | `false` | true 保存最多 5 MiB 原始 stdout |

`prompt` 最多 24,000 字符；Windows 转义后的组合命令行最多 30,000 字符。两个期限参数均须大于 0、最多 1440 分钟。输入错误在模型启动前拒绝。

默认 [config.json](config.json)：

```json
{
  "defaultModel": "gemini-3.8-flash-high",
  "defaultEffort": "high"
}
```

默认模型须在你的 agy 账号中可用；不可用时由用户显式指定可用模型，不自动替换。续接的模型与强度按“本次显式值 → 会话保存值 → 服务默认值”选择。可通过绝对路径 `ANTIGRAVITY_CONFIG_PATH` 使用自定义配置；启动时只读，不改写。

客户端另有工具请求超时。Codex 可通过 `tool_timeout_sec` 调整单次请求等待；它不是 MCP 任务执行期限。预计超过客户端单次等待能力时，先异步取得 taskId。客户端超时不证明任务未执行，不要重复提交。[Codex 配置说明](https://developers.openai.com/codex/config-reference/)

## 结果、权限与运行边界

- **SUCCESS 表示 agy 调用成功，不表示业务成果已验收。** 父 agent 仍需检查改动和独立运行测试；无文件改动的编码任务也可成功。
- 支持 RUNNING、SUCCESS、ERROR、CANCELLED、TIMEOUT 五种任务状态。错误保留 `errorCode`、`failureStage`、`errorMessage`、`nextAction` 和已取得的响应、会话。
- 直接在真实工作目录执行。同目录及父子目录互斥；不同目录可并行。此租约不阻止用户、编辑器或其他软件修改文件。
- **默认自动审批会批准命令和文件写入。** MCP 使用原生 `--dangerously-skip-permissions` 并传入 `--sandbox`；需要本机权限和白名单时传 `auto_approve: false`。审批不能解决 OS 权限、文件占用或沙箱限制。[agy headless 权限](https://antigravity.google/docs/cli/headless/#permissions-in-headless-mode)
- 执行层只解析官方 stream-json / NDJSON。无合法最终结果、损坏 JSON、上游错误或非零退出不能仅因模型说“完成”而成功。未知事件忽略，不触发重跑。
- `recentTools` 最多五次操作；工具 DONE 只表示结束。`latestText` 是当前响应步骤最后 4,000 字符，完整最终报告在 `response`。
- `stderrTail` 保留真正末尾最多 8,192 字符。原始 stdout 默认不落盘；调试日志达到上限会标记截断，解析继续消费完整输入。
- `usage` 保留上游原始值，统计范围为 session 或 unknown；不计算费用或将续接的累计用量相加。本地耗时和上游时长分别返回。
- 有效同步请求提供 `progressToken` 时可收到真实阶段通知。通知发送、客户端展示和父 agent 恢复执行是不同能力；不承诺异步自动唤醒。
- 独立 worker 允许已接受任务在 stdio 断开后继续。实际宿主关闭行为须实机验收；电脑重启或 worker 被强制结束不会自动恢复执行。

任务与完整结果保存在当前用户的 `.gemini/antigravity-mcp-jobs-v1/`，保留最近 100 项完成任务，活动及待停止任务不清理。会话、租约和可选日志同样使用用户状态目录，不写入项目或插件缓存。相同状态目录下重连可用原任务 ID 查询；记录不可用不表示任务未执行。

## 更新

先结束活动任务或明确取消，再在仓库目录执行：

```powershell
git pull --ff-only
npm ci
npm run build
```

随后重新连接 MCP，让服务和 worker 使用同一版代码。现有进程不会自动加载新构建；更新不迁移、删除或重跑用户任务。默认配置有本机修改时，建议通过 `ANTIGRAVITY_CONFIG_PATH` 使用仓库外配置。

## 开发与验证

```powershell
npm ci
npm run check
```

`check` 依次构建、检查测试类型并运行回归。普通测试使用假 CLI，不调用真实模型。覆盖任务、额度、会话、取消、超时、目录互斥、进程身份、中文分片、长输出及本地包装；真实事件样本中的个人路径和会话标识已匿名化。

`npm test` 显式列出 `test/` 下的 `.test.ts` 文件，保留串行执行和 `tsx` 加载参数，兼容 Windows Node 20 不展开 `test/*.test.ts` 的情况。测试发现不依赖 shell 通配符展开。

[CI 工作流](.github/workflows/ci.yml) 当前仅在 `windows-latest` 上使用 Node 20 和 22，形成两组基线；Ubuntu CI 暂缓。推送到 `main` 或 `optimize/p0`、提交 pull request 或手动触发时执行 `npm ci` 和 `npm run check`，每组限时 30 分钟。某组失败不会取消其他组合；命令失败仍保留失败退出码，不把已知基线失败隐藏为成功。普通 CI 固定 `ANTIGRAVITY_LIVE_TESTS=0`，不调用真实 agy 或模型。

本阶段先以 Windows 两组复验通过作为继续 P0 的条件。Ubuntu CI 恢复后再补充 Linux 验证；Windows 结果不能作为 Linux `/proc` 扫描及信号清理的验收依据。

每组运行都会尝试上传 artifact `baseline-${os}-node-${node}-attempt-${run_attempt}`，保留 30 天，包含：

- `ci-environment.log`：实际检出的提交哈希、Node/npm 版本和平台信息。
- `npm-ci.log`：依赖安装输出。
- `node-test-output.log`：`check` 的完整输出，包括构建、测试类型检查及 `node --test` 的用例结果和统计。

安装、构建或类型检查失败可能导致测试未运行；此时测试数量记为“未取得”，缺失日志会给出警告。基线采集可能包含尚未修复的失败，应按提交哈希、平台与 Node 版本记录通过、失败、跳过数量及失败用例名，再与后续任务对比。验证报告分别列出 Windows 本机实测、CI 实测和未验证项；本机构建或类型检查通过不能代替 Linux 运行结果。

Windows 测试需要正常的路径解析、原子文件更新、CIM 和子进程终止权限。真实 agy 验收脚本为 `scripts/live-cli-compat.mjs`，只有单独授权并设置 `ANTIGRAVITY_LIVE_TESTS=1` 后才能运行；程序化 stdio 测试不能替代真实客户端或真实模型验收。

Windows worker 启动失败时，错误诊断保留系统的 `code`、`signal`、`killed`，以及 `AGY_MCP_WORKER_STAGE` 标记，用于区分 PowerShell 初始化、CIM 创建和进程身份读取等阶段。启动期限仍为 10 秒，失败不会自动重试；成功结果不增加诊断字段。

Windows worker 的环境准备使用进程级 .NET API，所需 Utility 和 CIM 模块从 Windows PowerShell 自带目录显式加载，避免依赖用户或全局模块的自动发现。内部传递的命令和目录变量在创建 worker 前清除，其他环境变量继续继承；创建标志、PID 与创建时间校验及 10 秒创建等待期限保持不变。

Windows PowerShell 的 Job 启动器编译时，若临时路径包含系统 ANSI 代码页无法表示的字符，仅在编译期间使用当前用户的 `LocalApplicationData/Temp`。编译结束后恢复原有 `TEMP`、`TMP`，CLI 的工作目录和环境继续保留中文、空格及 emoji。若该编译目录也无法表示或无法写入，启动明确失败；可将 `TEMP`、`TMP` 配置为当前代码页可表示的可写路径。

CI 使用 `ANTIGRAVITY_TEST_DIAGNOSTICS=1` 记录插件包装验收的调用阶段与返回状态。stdio 取消断言失败时附带保存的任务状态和原生/CIM 进程身份快照，便于定位停止未确认；这些诊断来自假 CLI 测试，不调用真实 agy。

Windows 停止未确认时，现有 `stderrTail` 保留 `AGY_MCP_STOP_DIAGNOSTIC`，区分身份读取、CIM 枚举和终止阶段。诊断保留原有创建标识、停止校验与期限，不能将未确认状态视为已经停止。

Windows Job 启动器与停止辅助脚本通过 `$PSHOME` 的明确路径加载自带模块，启动器使用 .NET API 清除私有环境变量，避免启动和取消依赖用户或全局模块的自动发现。

原生额度查询没有 `stderrTail` 字段；其停止未确认的诊断附在现有 `errorMessage` 中。CI 包装调用失败时也打印现有 `stderrTail`，以保留停止阶段信息。

测试收尾使用 PID 和保存的创建标识确认原 worker 退出；PID 被复用时，新的无关实例保持原状。同一实例存活或身份未知时仍等待，超时日志保留任务 ID、PID、预期和实际创建标识，15 秒期限不变。

命令行整体长度上限的回归分别注入 Windows 和 Linux 平台，字段与 NUL 限制仍在所有平台断言。worker 崩溃后关闭 Job 的用例只在 Windows 执行，其他平台注明机制不适用的原因后跳过，保留 Windows 上的完整断言。

协作 Skill 位于 [plugin/skills/antigravity-delegation/SKILL.md](plugin/skills/antigravity-delegation/SKILL.md)，只有用户明确授权后调用 MCP。普通委派不另存提示词、提交记录、进度历史或重复最终结果；明确要求报告或证据时仅保存必要材料。

仓库保留本地插件打包源和 `npm run package:plugin`，产物生成于 `release/`。**本次 GitHub 分发以源码接入为主，不发布插件 ZIP 或插件市场。** 本地打包说明见 [plugin/README.md](plugin/README.md)。

## 许可证

[MIT](LICENSE)。本项目为独立工具，不隶属于 Google、OpenAI 或 Antigravity。
