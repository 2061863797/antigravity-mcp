<#
.SYNOPSIS
  把本目录注册为本地插件市场，并在 Codex 和/或 Claude Code 中安装 Antigravity MCP 插件。
.PARAMETER Client
  auto（默认，安装到本机已有的客户端）、codex、claude 或 all。
.PARAMETER DryRun
  只打印将要执行的命令，不做任何修改。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1
#>
param(
  [ValidateSet('auto', 'codex', 'claude', 'all')][string]$Client = 'auto',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$marketplace = 'antigravity-local'
$plugin = 'antigravity-mcp'

if (-not (Test-Path -LiteralPath (Join-Path $root 'plugins\antigravity-mcp\runtime\dist\index.js'))) {
  throw '安装包不完整：缺少 plugins\antigravity-mcp\runtime。请完整解压 ZIP 后在解压目录中运行本脚本。'
}

# 运行环境检查：Node.js 是必需的，agy 缺失只提示（安装插件本身不需要 agy）。
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw '未找到 Node.js。请先安装 Node.js 20 或更高版本。' }
$nodeMajor = [int](((& node --version) -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 20) { throw "Node.js 版本过低（当前 $(& node --version)），需要 20 或更高版本。" }
$agyFound = $env:AGY_PATH -or (Get-Command agy -ErrorAction SilentlyContinue) -or
  ($env:LOCALAPPDATA -and (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe')))
if (-not $agyFound) { Write-Warning '未找到 agy。插件可以安装，但运行任务前需要安装并登录 agy，或设置 AGY_PATH。' }

$targets = switch ($Client) {
  'auto' { @('codex', 'claude') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue } }
  'all' { @('codex', 'claude') }
  default { @($Client) }
}
if (-not $targets) { throw '未找到 codex 或 claude 命令。请先安装 Codex CLI 或 Claude Code，或用 -Client 指定。' }

function Invoke-Step([string]$Executable, [string[]]$Arguments) {
  Write-Host ('> ' + $Executable + ' ' + (($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '))
  if ($DryRun) { return }
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Executable 执行失败（退出码 $LASTEXITCODE）。" }
}

# 同名市场已注册时不覆盖，避免静默安装旧目录中的旧版本。
function Test-Registered([string]$Executable) {
  if ($DryRun) { return $false }
  if ($Executable -eq 'claude') {
    $list = (& claude plugin marketplace list --json) -join "`n" | ConvertFrom-Json
    return [bool]($list | Where-Object { $_.name -eq $marketplace })
  }
  $lines = & codex plugin marketplace list
  return [bool]($lines | Where-Object { ($_ -split '\s+')[0] -eq $marketplace })
}

foreach ($target in $targets) {
  $name = if ($target -eq 'codex') { 'Codex' } else { 'Claude Code' }
  Write-Host "`n== $name =="
  if (Test-Registered $target) {
    $remove = if ($target -eq 'codex') { "codex plugin marketplace remove $marketplace" } else { "claude plugin marketplace remove $marketplace" }
    throw "$name 已注册名为 $marketplace 的插件市场（可能指向旧版本目录）。如需升级，先运行：$remove，然后重新运行本脚本。"
  }
  Invoke-Step $target @('plugin', 'marketplace', 'add', $root)
  if ($target -eq 'codex') { Invoke-Step 'codex' @('plugin', 'add', "$plugin@$marketplace") }
  else { Invoke-Step 'claude' @('plugin', 'install', "$plugin@$marketplace") }
}

if ($DryRun) { Write-Host "`n（DryRun：以上命令未执行）" }
else {
  Write-Host "`n安装完成。请重启客户端或重新连接 MCP，确认可以看到四个 antigravity 工具。"
  Write-Host '不要移动或删除本目录：Codex 和 Claude Code 的插件市场都登记在这里。'
}
