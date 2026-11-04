<#
  新机器一把拉起来：检查 Node → 安装依赖 → 构建 → 可选打包。
  用法：
    powershell -ExecutionPolicy Bypass -File scripts\bootstrap-fresh.ps1
    powershell -ExecutionPolicy Bypass -File scripts\bootstrap-fresh.ps1 -Package
#>
[CmdletBinding()]
param(
  [switch]$Package,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($text) { Write-Host "== $text" -ForegroundColor Cyan }

Step "1/5 检查 Node"
$nodeVersion = (& node -v) 2>$null
if (-not $nodeVersion) { throw "未找到 node，请先安装 Node.js 20 或更新版本。" }
$major = [int](($nodeVersion -replace '^v','').Split('.')[0])
Write-Host "node $nodeVersion"
if ($major -lt 20) { throw "Node 版本过低：需要 >= 20，当前 $nodeVersion" }

Step "2/5 安装依赖"
if ($SkipInstall) {
  Write-Host "已跳过（-SkipInstall）"
} elseif (Test-Path "package-lock.json") {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci 失败" }
} else {
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
}

Step "3/5 构建 runtime"
npm run build:runtime
if ($LASTEXITCODE -ne 0) { throw "runtime 构建失败" }

Step "4/5 构建主进程与界面"
npm run build
if ($LASTEXITCODE -ne 0) { throw "主程序构建失败" }

Step "5/5 打包（可选）"
if ($Package) {
  npm run build:portable
  if ($LASTEXITCODE -ne 0) { throw "打包失败（常见原因：Electron 下载超时，可设 ELECTRON_MIRROR 后重试）" }
  Get-ChildItem "release-portable\*.zip" | ForEach-Object {
    Write-Host ("产物：{0}（{1:N1} MB）" -f $_.FullName, ($_.Length / 1MB)) -ForegroundColor Green
  }
} else {
  Write-Host "未指定 -Package，跳过打包。要出便携包请加 -Package。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "完成。下一步：" -ForegroundColor Green
Write-Host "  1) 开发运行：npm start"
Write-Host "  2) 或解压 release-portable 里的 zip 直接运行 exe"
Write-Host "  3) 首次启动后在「快速设置」选工作区、端口（内部 48766 / 远端 48767，禁止 48765）"
Write-Host "  4) 隧道与连接器需要在新机器重新配置与授权（详见 docs\FRESH_MACHINE.md）"
