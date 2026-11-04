<#
  自有域名隧道（Cloudflare Named Tunnel）：域名固定，适合长期使用。
  用法：
    powershell -ExecutionPolicy Bypass -File .\scripts\tunnel-named.ps1 -Domain mcp.example.com -Name linos-mcp
  可选：
    -Port 48766      本地 MCP 端口
    -Run:$false      只做配置，不启动隧道
  前置：域名已托管在 Cloudflare；cloudflared 已安装。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Domain,
  [string]$Name = "linos-mcp",
  [int]$Port = 48766,
  [switch]$Run
)

$ErrorActionPreference = "Stop"

function Resolve-Cloudflared {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($candidate in @("$env:ProgramFiles\cloudflared\cloudflared.exe", "$env:LOCALAPPDATA\cloudflared\cloudflared.exe", "C:\cfbin\cloudflared.exe")) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

$exe = Resolve-Cloudflared
if (-not $exe) {
  Write-Host "未找到 cloudflared。下载： https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -ForegroundColor Red
  Write-Host "放到 C:\cfbin\cloudflared.exe 或加入 PATH 后重跑。"
  exit 1
}

$configDir = Join-Path $env:USERPROFILE ".cloudflared"
$configPath = Join-Path $configDir "config.yml"
if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir | Out-Null }

Write-Host "`n==> 1/4 检查 Cloudflare 登录状态" -ForegroundColor Cyan
$certPath = Join-Path $configDir "cert.pem"
if (-not (Test-Path $certPath)) {
  Write-Host "需要先登录一次（会打开浏览器选择你的域名）：" -ForegroundColor Yellow
  Write-Host "  & `"$exe`" tunnel login" -ForegroundColor Gray
  & $exe tunnel login
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $certPath)) {
    Write-Host "登录未完成，退出。" -ForegroundColor Red
    exit 1
  }
}
Write-Host "[OK] 已登录" -ForegroundColor Green

Write-Host "`n==> 2/4 创建/复用命名隧道：$Name" -ForegroundColor Cyan
$listRaw = & $exe tunnel list 2>$null
$exists = ($listRaw | Select-String -SimpleMatch $Name) -ne $null
if (-not $exists) {
  & $exe tunnel create $Name
  if ($LASTEXITCODE -ne 0) { Write-Host "创建隧道失败（名字可能已被占用）。" -ForegroundColor Red; exit 1 }
  Write-Host "[OK] 已创建 $Name" -ForegroundColor Green
  # 新建后必须重新取列表：否则拿的是创建前的旧列表，解析不到 ID。
  $listRaw = & $exe tunnel list 2>$null
} else {
  Write-Host "[OK] 复用已有隧道 $Name" -ForegroundColor Green
}

$tunnelId = (($listRaw | Select-String -SimpleMatch $Name) -split "\s+")[0]
if (-not $tunnelId) { Write-Host "无法解析 tunnel id，请手动执行 cloudflared tunnel list。" -ForegroundColor Red; exit 1 }

Write-Host "`n==> 3/4 绑定域名 $Domain → 127.0.0.1:$Port" -ForegroundColor Cyan
& $exe tunnel route dns $Name $Domain
if ($LASTEXITCODE -ne 0) {
  Write-Host "DNS 绑定失败：请到 Cloudflare 控制台检查 $Domain 是否已存在同名记录。" -ForegroundColor Red
  Write-Host "注意：本脚本不会覆盖已有记录；如需替换请先手工删除旧记录再重跑。" -ForegroundColor Yellow
  exit 1
}
Write-Host "[OK] DNS 命令执行成功（是否真的指向本隧道，请用 Resolve-DnsName $Domain 复核）" -ForegroundColor Green

$config = @"
tunnel: $tunnelId
credentials-file: $configDir\$tunnelId.json

ingress:
  - hostname: $Domain
    service: http://127.0.0.1:$Port
  - service: http_status:404
"@
if (Test-Path $configPath) {
  $backup = "$configPath.bak-$(Get-Date -Format yyyyMMddHHmmss)"
  Copy-Item $configPath $backup
  Write-Host "[!] 已备份原配置到 $backup" -ForegroundColor Yellow
}
$config | Set-Content -Path $configPath -Encoding utf8
Write-Host "[OK] 写入 $configPath" -ForegroundColor Green

Write-Host "`n==> 4/4 验证" -ForegroundColor Cyan
if ($Run) {
  Write-Host "启动隧道（Ctrl+C 结束）…" -ForegroundColor Gray
  & $exe tunnel run $Name
} else {
  Write-Host "配置完成。启动隧道：" -ForegroundColor Gray
  Write-Host "  & `"$exe`" tunnel run $Name" -ForegroundColor Gray
  Write-Host "`n启动后验证：" -ForegroundColor Gray
  Write-Host "  Invoke-WebRequest https://$Domain/health -UseBasicParsing" -ForegroundColor Gray
  Write-Host "MCP URL： https://$Domain/mcp" -ForegroundColor Gray
}
