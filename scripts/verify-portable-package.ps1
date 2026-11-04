#Requires -Version 5.1
<#
.SYNOPSIS
  48767 portable 包测试机验包脚本（小范围验证第 0 步）。
.DESCRIPTION
  1) 校验 zip SHA256 是否与验收单一致；
  2) 解压并确认关键模块存在；
  3) 确认本机 48767 端口空闲（避免与已跑的控制中心冲突）。
  全部通过后再按 docs/48767_PARALLEL_RUN_ACCEPTANCE.md 做 5 项实测。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\verify-portable-package.ps1 `
    -ZipPath D:\pkg\LinOS-MCP-Portable-2.0.0-dev.0-x64.zip -DestDir D:\pkg\linos-48767-test
#>
param(
  [Parameter(Mandatory = $true)][string]$ZipPath,
  [Parameter(Mandatory = $true)][string]$DestDir,
  [string]$ExpectedHash = "E5007635E3C9BC0701467BB73F1995CF266C4C64DD32108BB3D62F8CCDAAB16A"
)

$ErrorActionPreference = "Stop"

Write-Output "== 1/3 校验 SHA256 =="
$actual = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToUpperInvariant()
if ($actual -ne $ExpectedHash.ToUpperInvariant()) {
  throw "哈希不一致，包可能损坏或版本不对。实际=$actual 期望=$ExpectedHash"
}
Write-Output "哈希一致。"

Write-Output "== 2/3 解压并确认关键模块 =="
if (Test-Path $DestDir) { throw "目标目录已存在，请换一个空目录：$DestDir" }
Expand-Archive -Path $ZipPath -DestinationPath $DestDir
$required = @(
  "LinOS MCP.exe",
  "resources\app\runtime\dist\job-store.js",
  "resources\app\runtime\dist\job-runner.js",
  "resources\app\runtime\dist\job-tools.js",
  "resources\app\dist\main\jobs\JobReader.js"
)
foreach ($rel in $required) {
  $full = Join-Path $DestDir $rel
  if (-not (Test-Path $full)) { throw "缺失关键文件：$rel" }
  Write-Output "  OK $rel"
}

Write-Output "== 3/3 端口现状（仅报告，不拦截） =="
foreach ($p in @(48765, 48766, 48767)) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($c) {
    $proc = (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    Write-Output "  $p 已占用（PID $($c.OwningProcess)，$proc）"
  } else {
    Write-Output "  $p 空闲"
  }
}
Write-Output "提示：验包只校验包完整性；端口怎么选交给 home-setup.ps1（它会自动找空闲端口）。"

Write-Output ""
Write-Output "验包通过。下一步：运行解压目录里的 LinOS MCP.exe，完成配对后按验收单做 5 项实测。"
