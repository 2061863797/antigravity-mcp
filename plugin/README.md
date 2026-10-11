# Antigravity MCP 插件 2.0.0

同时适用于 **Codex** 和 **Claude Code** 的本地插件，包含：

- Antigravity MCP 服务：提供 `antigravity_ask`、`antigravity_code`、`antigravity_status`、`antigravity_cancel_task` 四个工具。
- 协作 Skill `antigravity-delegation`：约定 agent 何时、如何委派任务。
- 运行所需的全部依赖：不需要源码仓库，也不需要 `npm install`。

这是一个 ZIP 包，不是 EXE 安装程序。目前只支持 Windows。

## 安装前准备

1. 安装 Node.js 20 或更高版本，确认 `node --version` 能正常输出。
2. 安装并登录 agy，确认 `agy --version` 能正常输出（参见 [agy 官方文档](https://antigravity.google/docs/cli/headless/)）。
3. 把 ZIP 解压到一个**长期保留**的目录，例如 `C:\Tools\antigravity-mcp-plugin-2.0.0`。

   客户端会从这个目录加载插件，安装后不要移动或删除它。解压后，目录里应该直接能看到 `install.ps1`、`plugins`、`.agents`、`.claude-plugin`。

## 一键安装

在解压目录中打开 PowerShell，运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：

1. 检查 Node.js 版本；找不到 agy 时给出提示。
2. 找出本机已安装的客户端（`codex`、`claude` 命令），只给已安装的客户端注册插件市场 `antigravity-local`。
3. 在这些客户端中安装插件 `antigravity-mcp`。

常用参数：

| 参数 | 作用 |
| --- | --- |
| `-Client codex` / `-Client claude` | 只安装到指定的客户端 |
| `-Client all` | 两个客户端都安装（任一命令不存在时会失败） |
| `-DryRun` | 只打印将要执行的命令，不做任何修改 |

安装完成后，重启客户端或重新连接 MCP，确认能看到四个 antigravity 工具。

## 手动安装

不想运行脚本时，把下面命令中的 `<解压目录>` 换成实际路径。

**Codex**

```powershell
codex plugin marketplace add "<解压目录>"
codex plugin add antigravity-mcp@antigravity-local
```

**Claude Code**

```powershell
claude plugin marketplace add "<解压目录>"
claude plugin install antigravity-mcp@antigravity-local
```

## 指定 agy 路径

插件会依次从 PATH 和 `%LOCALAPPDATA%\agy\bin\agy.exe` 查找 agy。如果 agy 装在其他位置，在启动客户端之前设置用户环境变量 `AGY_PATH`，指向 `agy.exe` 的完整路径，然后重启客户端。

## 第一次使用

在对话中明确要求使用 Antigravity MCP，例如：

> 用 Antigravity MCP 只读检查 C:\Projects\demo 的入口文件，先不要修改。

安装插件不等于授权 agent 运行模型任务；协作 Skill 要求必须由你明确提出后才会调用。

默认设置：

- 模型 `gemini-3.8-flash-high`，推理强度 `high`。
- 自动审批开启：agy 可以直接执行命令、写入文件，所以委派时请说清任务范围。
- 不保存原始输出日志。

任务返回 `SUCCESS` 只表示 agy 调用成功，agent 仍需检查文件改动和测试结果。

任务、结果和会话保存在用户主目录的 `.gemini\` 下，不在插件目录里，所以升级或卸载插件不会丢失这些记录。失败或取消的任务会保留已有的文件改动。

## 升级

1. 等待正在运行的任务结束，或先取消它们。
2. 把新版本解压到一个**新目录**。
3. 移除旧的市场注册（只执行你装过的客户端那一行）：

   ```powershell
   codex plugin marketplace remove antigravity-local
   claude plugin marketplace remove antigravity-local
   ```

4. 在新目录中重新运行 `install.ps1`。
5. 确认新版本可用后，再删除旧目录。

如果没有先执行第 3 步，脚本检测到同名市场后会停止并提示，不会静默装上旧版本。

## 卸载

1. 先确认相关任务已经结束（禁用插件不会自动取消后台任务）。
2. 执行对应客户端的命令：

   ```powershell
   codex plugin remove antigravity-mcp
   codex plugin marketplace remove antigravity-local
   claude plugin uninstall antigravity-mcp
   claude plugin marketplace remove antigravity-local
   ```

3. 之后可以删除解压目录。`.gemini\` 下的任务记录会保留，是否删除由你决定。

## 安装包结构

```text
install.ps1                         一键安装脚本
LICENSE                            本项目版权和 MIT 许可文本
.agents/plugins/marketplace.json    Codex 插件市场清单
.claude-plugin/marketplace.json     Claude Code 插件市场清单
plugins/antigravity-mcp/
  LICENSE                          安装后的插件保留本项目许可文本
  plugin.json, mcp.json             Codex 插件清单
  .claude-plugin/plugin.json        Claude Code 插件清单
  skills/antigravity-delegation/    协作 Skill（两个客户端共用）
  runtime/                          MCP 服务、LICENSE 及其依赖（两个客户端共用）
```
