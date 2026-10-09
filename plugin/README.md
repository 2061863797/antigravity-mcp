# Antigravity MCP 本地插件 2.0.0

这是 Windows Codex 本地插件，内含 MCP、协作 Skill 和生产运行依赖。无需原桌面工程，也无需全局安装 `antigravity-mcp`。ZIP 用于分享，解压后安装；它不是 EXE。

## 安装与启用

1. 安装 Node.js 20+，确认 `node --version` 可用。安装 agy 并完成登录，确认 `agy --version` 可用。
2. 将 ZIP 解压到长期保留的目录，例如 `C:\Tools\antigravity-mcp-plugin-2.0.0`。该目录应直接包含 `README.md`、`.agents` 和 `plugins`。
3. 在 PowerShell 注册这个本地市场根目录：

   ```powershell
   codex plugin marketplace add "C:\Tools\antigravity-mcp-plugin-2.0.0"
   ```

4. 在 Codex 的插件界面找到“Antigravity MCP”，安装并启用。必要时刷新插件界面或重新打开客户端。市场注册本身不等于插件已安装。
5. 确认插件提供四个工具：`antigravity_ask`、`antigravity_code`、`antigravity_status`、`antigravity_cancel_task`。插件生效后，再由用户禁用旧手工 MCP 配置及重复全局 Skill；保留旧文件、任务记录和 agy-staff。

Codex CLI 未在 PATH 中时，使用本机 Codex CLI 可执行文件的完整路径运行同一命令。整个解压目录须保留；不要只移动 `plugin.json` 或注册 ZIP 路径。

## 第一次使用

在对话中明确要求使用 Antigravity MCP，例如：“用 Antigravity MCP 只读检查 C:\Projects\demo 的入口文件，先不修改。”安装和登录本身不授权运行模型任务。

协作 Skill 按任务选择同步或异步。同步适合后续工作依赖结果；异步适合父 agent 能并行推进独立工作。异步返回 taskId，可查询、取消或重连后继续查询；不承诺自动唤醒父 agent。显式 conversation_id 用于在原目录续接。

默认模型 `gemini-3.8-flash-high`、强度 `high`、自动审批开启、原始日志关闭。自动审批允许 agy 执行命令和写文件，仍须明确任务及安全范围。调用 SUCCESS 表示 agy 调用成功，父 agent 仍须检查文件和测试。

任务、结果、会话和目录租约仍存放在当前用户的现有状态目录，不放进插件缓存。失败和取消保留已有文件改动。插件不安装 agy、不代替登录，不新增隔离、回滚或 Hook。

## 升级

先等待活动任务结束或由用户明确取消，再在插件界面禁用旧插件。将新包解压到新目录，用 `codex plugin marketplace remove antigravity-local` 移除旧市场注册，再用 `codex plugin marketplace add "新目录"` 注册，按界面提示重新安装或启用插件并重新连接。不要在活动 worker 使用包内文件时覆盖或删除旧目录。

卸载和升级不迁移、清理或重跑任务；保留 taskId 和 conversation_id，以便读取已有记录。本文命令仅用于用户实际安装阶段，打包脚本不会执行。

## 卸载

在 Codex 插件界面禁用并卸载 Antigravity MCP；不再需要市场时运行 `codex plugin marketplace remove antigravity-local`。禁用插件不会代替取消后台任务，先确认相关任务已经结束。用户状态目录、旧工程和 agy-staff 均保留；是否删除解压目录由用户决定。

本地市场和根目录清单遵循[官方插件打包与安装说明](https://developers.openai.com/plugins/build/plugins)。包内 stdio 测试通过，只证明运行包可启动；实际 Codex 插件界面的安装、展示和加载需要另行验收。
