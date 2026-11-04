<#
  一键安装：检查环境 → 装依赖 → 构建 runtime → 构建界面
  用法：powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
  可选：-SkipTests 跳过自检，-Port 48766 指定默认端口
#>
[CmdletBinding()]
param(
  [switch]$SkipTests,
  [int]$Port = 48766
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    [OK] $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    [!] $text" -ForegroundColor Yellow }

Write-Step "检查 Node.js"
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  Write-Host "未找到 Node.js。请安装 Node.js 20 或更高版本：https://nodejs.org/" -ForegroundColor Red
  exit 1
}
$nodeVersion = (& node -v).TrimStart("v")
$major = [int]($nodeVersion.Split(".")[0])
if ($major -lt 20) {
  Write-Host "Node.js 版本过低（$nodeVersion），需要 >= 20。" -ForegroundColor Red
  exit 1
}
Write-Ok "Node.js $nodeVersion"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "未找到 npm，请重装 Node.js。" -ForegroundColor Red
  exit 1
}

Write-Step "安装主程序依赖（npm ci）"
& npm ci
if ($LASTEXITCODE -ne 0) { Write-Host "npm ci 失败。" -ForegroundColor Red; exit 1 }
Write-Ok "主程序依赖完成"

Write-Step "构建 runtime"
& npm run build:runtime
if ($LASTEXITCODE -ne 0) { Write-Host "构建 runtime 失败。" -ForegroundColor Red; exit 1 }
Write-Ok "runtime 构建完成"

Write-Step "构建控制中心界面"
& npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "构建界面失败。" -ForegroundColor Red; exit 1 }
Write-Ok "界面构建完成"

if (-not $SkipTests) {
  Write-Step "类型检查与测试"
  & npm run typecheck
  if ($LASTEXITCODE -ne 0) { Write-Warn2 "类型检查有告警，继续。" }
  & npm test
  if ($LASTEXITCODE -ne 0) { Write-Warn2 "主包测试未全绿（部分时序类测试可能偶发失败，可重跑）。" }
  Push-Location runtime
  & npm test
  if ($LASTEXITCODE -ne 0) { Write-Warn2 "runtime 测试未全绿（同上）。" }
  Pop-Location
}

Write-Step "完成"
Write-Host @"
下一步：
  1) 启动：            npm start
  2) 首次设置：        选工作区目录、端口（默认 $Port）、生成配对码
  3) 公网访问（可选）：
       - 临时域名（当天试用）： powershell -ExecutionPolicy Bypass -File .\scripts\tunnel-quick.ps1
       - 自有域名（长期）：     powershell -ExecutionPolicy Bypass -File .\scripts\tunnel-named.ps1 -Domain mcp.example.com

详细说明见 docs\INSTALL.md
"@ -ForegroundColor Gray
