#Requires -Version 5.1
<#
.SYNOPSIS
  v0.1.1 portable package static verification (ASCII-only on purpose).
.DESCRIPTION
  Static checks only (never launches the GUI):
    1) print zip SHA256 (optionally enforce -ExpectedHash);
    2) extract into an empty directory;
    3) required files must exist;
    4) forbidden content must not exist (root node_modules, source maps, test output, removed deps);
    5) print size stats.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\verify-portable-assets.ps1 `
    -ZipPath .\release-portable\LinOS-MCP-Portable-0.1.0-x64.zip `
    -DestDir $env:TEMP\linos-portable-check
#>
param(
  [Parameter(Mandatory = $true)][string]$ZipPath,
  [Parameter(Mandatory = $true)][string]$DestDir,
  [string]$ExpectedHash = ""
)

$ErrorActionPreference = "Stop"

Write-Output "== 1/5 SHA256 =="
if (-not (Test-Path $ZipPath)) { throw "zip not found: $ZipPath" }
$hash = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$sizeMb = [math]::Round((Get-Item $ZipPath).Length / 1MB, 2)
Write-Output "sha256=$hash size=${sizeMb}MB"
if ($ExpectedHash -and $hash -ne $ExpectedHash.ToLowerInvariant()) {
  throw "hash mismatch: expected=$ExpectedHash actual=$hash"
}

Write-Output "== 2/5 extract =="
if (Test-Path $DestDir) { Remove-Item -Path $DestDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
Expand-Archive -Path $ZipPath -DestinationPath $DestDir
$app = Join-Path $DestDir "resources\app"
Write-Output "extracted=$DestDir"

Write-Output "== 3/5 required files =="
$required = @(
  "LinOS MCP.exe",
  "resources\app\package.json",
  "resources\app\dist\main\main.js",
  "resources\app\dist\main\audit\AuditChain.js",
  "resources\app\runtime\package.json",
  "resources\app\runtime\dist\main.js",
  "resources\app\runtime\dist\server.js",
  "resources\app\runtime\dist\tool-audit.js",
  "resources\app\runtime\node_modules\express\package.json",
  "resources\app\extension\manifest.json",
  "resources\app\extension\content.js"
)
$missing = @()
foreach ($rel in $required) {
  if (-not (Test-Path (Join-Path $DestDir $rel))) { $missing += $rel }
}
if ($missing.Count -gt 0) {
  $missing | ForEach-Object { Write-Output "  MISSING $_" }
  throw "package is missing required files: $($missing.Count)"
}
Write-Output "required files ok: $($required.Count)"

Write-Output "== 4/5 forbidden content =="
$violations = @()
# Renderer is bundled by Vite, so react deps must stay in devDependencies.
foreach ($rendererDep in @("react", "react-dom", "react-router-dom", "react-router", "scheduler")) {
  if (Test-Path (Join-Path $app "node_modules\$rendererDep")) {
    $violations += "renderer-only dep shipped in app/node_modules: $rendererDep"
  }
}
# mysql2 is imported dynamically by the main process, so it must ship.
if (-not (Test-Path (Join-Path $app "node_modules\mysql2\package.json"))) {
  $violations += "mysql2 missing from app/node_modules (main process imports it dynamically)"
}
$maps = @(Get-ChildItem -Path $app -Recurse -File -Filter *.map -ErrorAction SilentlyContinue)
if ($maps.Count -gt 0) { $violations += "source maps found: $($maps.Count)" }
$tests = @(Get-ChildItem -Path $app -Recurse -File -Include *.test.js,*.spec.js -ErrorAction SilentlyContinue)
if ($tests.Count -gt 0) { $violations += "test artifacts found: $($tests.Count)" }
$ts = @(Get-ChildItem -Path (Join-Path $app "runtime\dist") -Recurse -File -Filter *.ts -ErrorAction SilentlyContinue)
if ($ts.Count -gt 0) { $violations += "typescript sources found in runtime/dist: $($ts.Count)" }
if (Test-Path (Join-Path $app "runtime\node_modules\@modelcontextprotocol")) { $violations += "removed dep still shipped: @modelcontextprotocol" }
if (Test-Path (Join-Path $app "runtime\node_modules\zod")) { $violations += "removed dep still shipped: zod" }
if ($violations.Count -gt 0) {
  $violations | ForEach-Object { Write-Output "  VIOLATION $_" }
  throw "package content violations: $($violations.Count)"
}
Write-Output "no forbidden content"

Write-Output "== 5/5 stats =="
$all = @(Get-ChildItem -Path $DestDir -Recurse -File)
$modules = @(Get-ChildItem -Path (Join-Path $app "runtime\node_modules") -Recurse -File -ErrorAction SilentlyContinue)
$totalMb = [math]::Round((($all | Measure-Object Length -Sum).Sum) / 1MB, 2)
$modulesMb = [math]::Round((($modules | Measure-Object Length -Sum).Sum) / 1MB, 2)
Write-Output "files=$($all.Count) totalMB=$totalMb runtimeModulesMB=$modulesMb"
Write-Output "STATIC-CHECK=PASS"
