#Requires -Version 5.1
<#
.SYNOPSIS
  Diagnose a Cloudflare named tunnel that returns 530 / error 1033.
.DESCRIPTION
  Reproduces the checks that actually decide whether a named tunnel can work:
    1) local runtime health on the expected port;
    2) DNS answers for the tunnel hostname and the Cloudflare edge (fake-IP detection);
    3) cloudflared precheck (QUIC + TCP 7844 against region1/region2);
    4) public endpoint status and Cloudflare error code.
  It prints a verdict plus the remediation that matches the evidence.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\diagnose-tunnel.ps1 `
    -ProfileDir "$env:LOCALAPPDATA\linos-c2c-control-center\profiles\<id>" `
    -PublicUrl "https://example.linosai.com"
#>
param(
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [Parameter(Mandatory = $true)][string]$PublicUrl,
  [string]$CloudflaredPath = "D:\cfbin\cloudflared.exe",
  [int]$LocalPort = 48766,
  [string]$TunnelName = "linos-c2c-company"
)

$ErrorActionPreference = "Continue"

function Get-HttpStatus {
  param([string]$Url, [int]$TimeoutSec = 10)
  try {
    $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
    return @{ Status = [int]$resp.StatusCode; Body = [string]$resp.Content }
  } catch {
    $web = $_.Exception
    if ($web.Response) {
      $code = 0
      try { $code = [int]$web.Response.StatusCode } catch { }
      $body = ""
      try {
        $stream = $web.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $body = $reader.ReadToEnd()
        $reader.Close()
      } catch { }
      return @{ Status = $code; Body = $body }
    }
    return @{ Status = 0; Body = [string]$_.Exception.Message }
  }
}

$findings = New-Object System.Collections.Generic.List[string]
$fakeIp = $false

Write-Output "== 1/4 local runtime =="
$health = Get-HttpStatus -Url "http://127.0.0.1:$LocalPort/health" -TimeoutSec 5
Write-Output "local http://127.0.0.1:$LocalPort/health -> $($health.Status)"
if ($health.Status -ne 200) { $findings.Add("local runtime is not serving on port $LocalPort") }

Write-Output "== 2/4 DNS =="
$hostName = ([uri]$PublicUrl).Host
foreach ($name in @($hostName, "region1.v2.argotunnel.com", "region2.v2.argotunnel.com")) {
  $ips = @()
  try { $ips = @(Resolve-DnsName $name -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress) } catch { }
  Write-Output ("{0} -> {1}" -f $name, ($(if ($ips.Count) { $ips -join ", " } else { "(no answer)" })))
  foreach ($ip in $ips) {
    if ($ip -like "198.18.*" -or $ip -like "fdfe:dcba:9876::*") { $fakeIp = $true }
  }
}
if ($fakeIp) {
  $findings.Add("DNS answers come from a fake-IP range (198.18.0.0/15 or fdfe:dcba:9876::/48): a Clash/Mihomo style TUN proxy is hijacking DNS")
}

Write-Output "== 3/4 cloudflared precheck =="
$transportDir = Join-Path $ProfileDir "transport"
$config = Get-ChildItem -Path $transportDir -Filter "cloudflared-*.yml" -ErrorAction SilentlyContinue | Select-Object -First 1
$credential = Get-ChildItem -Path $transportDir -Filter "credential-*.json" -ErrorAction SilentlyContinue | Select-Object -First 1
$precheckHardFail = $false
$dialFailed = $false
$registered = $false
if (-not (Test-Path $CloudflaredPath)) {
  $findings.Add("cloudflared binary not found: $CloudflaredPath")
} elseif (-not $config) {
  $findings.Add("no generated cloudflared config under $transportDir")
} else {
  $errFile = Join-Path $env:TEMP "cf-diag-$([guid]::NewGuid().ToString('N')).log"
  $proc = Start-Process -FilePath $CloudflaredPath -ArgumentList @(
    "tunnel", "--no-autoupdate", "--config", $config.FullName, "run",
    "--credentials-file", $credential.FullName, $TunnelName
  ) -PassThru -RedirectStandardOutput ($errFile + ".out") -RedirectStandardError $errFile -WindowStyle Hidden
  Start-Sleep -Seconds 14
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  $log = Get-Content $errFile -ErrorAction SilentlyContinue
  $log | Where-Object { $_ -match "precheck component|Registered tunnel connection|Failed to dial|hard_fail" } |
    ForEach-Object { Write-Output "  $_" }
  if ($log -match "hard_fail=true") { $precheckHardFail = $true }
  if ($log -match "Failed to dial") { $dialFailed = $true }
  if ($log -match "Registered tunnel connection") { $registered = $true }
  if ($precheckHardFail) { $findings.Add("cloudflared precheck failed: edge connectivity is blocked") }
  if ($dialFailed) { $findings.Add("cloudflared could not dial the edge (QUIC/TCP 7844 unreachable)") }
  Remove-Item $errFile, ($errFile + ".out") -Force -ErrorAction SilentlyContinue
}

Write-Output "== 4/4 public endpoint =="
$pub = Get-HttpStatus -Url "$($PublicUrl.TrimEnd('/'))/health" -TimeoutSec 15
Write-Output "public -> $($pub.Status)"
if ($pub.Status -eq 530 -or $pub.Body -match "1033") {
  $findings.Add("Cloudflare returns 530 / error 1033: the tunnel has no active connection to the edge")
}
if ($pub.Status -eq 0) { $findings.Add("public endpoint unreachable: $($pub.Body)") }

Write-Output ""
Write-Output "== verdict =="
if ($registered -and $findings.Count -eq 0) {
  Write-Output "no blocking finding: tunnel path looks healthy"
} elseif ($findings.Count -eq 0) {
  Write-Output "no blocking finding recorded, but the probe did not observe a registered connection either"
} else {
  $findings | ForEach-Object { Write-Output "  - $_" }
  Write-Output ""
  Write-Output "== remediation =="
  if ($fakeIp) {
    Write-Output "  A. A TUN/fake-IP proxy is hijacking DNS, so cloudflared dials 198.18.x.x instead of the real edge."
    Write-Output "     Fix in the proxy config:"
    Write-Output "       - add fake-ip-filter entries: '*.argotunnel.com', '*.cloudflare.com'"
    Write-Output "       - add a rule that sends '*.argotunnel.com' and 'cloudflared.exe' DIRECT"
    Write-Output "       - or temporarily disable TUN mode while the tunnel runs"
  }
  if ($dialFailed) {
    Write-Output "  C. Allow outbound TCP and UDP on port 7844 to region1/region2.v2.argotunnel.com."
  }
  Write-Output "  D. Restarting the tunnel from the control center only re-spawns the same blocked path;"
  Write-Output "     fix the network path (A/C) first, then restart the tunnel once."
}
