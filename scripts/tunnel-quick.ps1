<#
  临时公网隧道（trycloudflare）：不需要账号，重启即换域名。
  用法：powershell -ExecutionPolicy Bypass -File .\scripts\tunnel-quick.ps1 [-Port 48766]
  注意：本机必须已在运行 MCP 服务（默认 127.0.0.1:48766）。
#>
[CmdletBinding()]
param([int]$Port = 48766)

$ErrorActionPreference = "Stop"

function Resolve-Cloudflared {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "$env:ProgramFiles\cloudflared\cloudflared.exe",
    "$env:LOCALAPPDATA\cloudflared\cloudflared.exe",
    "C:\cfbin\cloudflared.exe"
  )
  foreach ($candidate in $candidates) { if (Test-Path $candidate) { return $candidate } }
  return $null
}

$exe = Resolve-Cloudflared
if (-not $exe) {
  Write-Host "未找到 cloudflared。" -ForegroundColor Red
  Write-Host "下载（Windows amd64）： https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  Write-Host "下载后重命名为 cloudflared.exe，放到 C:\cfbin\ 或加入 PATH，再重跑本脚本。"
  exit 1
}

$health = "http://127.0.0.1:$Port/health"
try {
  $resp = Invoke-WebRequest $health -UseBasicParsing -TimeoutSec 5
  Write-Host "[OK] 本地服务在跑：$health = $($resp.StatusCode)" -ForegroundColor Green
} catch {
  Write-Host "[!] 本地 $health 不可达。请先启动控制中心（npm start）并确认端口为 $Port。" -ForegroundColor Yellow
  $answer = Read-Host "仍然继续启动隧道？(y/N)"
  if ($answer -notin @("y", "Y")) { exit 1 }
}

Write-Host "`n启动临时隧道，日志里找 https://<随机>.trycloudflare.com`n" -ForegroundColor Cyan
Write-Host "提示：MCP URL = 该地址 + /mcp ；每次重启域名都会变。" -ForegroundColor Gray
Write-Host "按 Ctrl+C 结束隧道。`n" -ForegroundColor Gray

& $exe tunnel --url "http://127.0.0.1:$Port"
