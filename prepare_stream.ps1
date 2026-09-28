$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$webDir = Join-Path $PSScriptRoot 'dist\Web'
$webExe = Join-Path $webDir 'SYNC-LIVE-Web.exe'
if (-not (Test-Path -LiteralPath $webExe)) { & (Join-Path $PSScriptRoot 'build_web.ps1') }

$obsExe = Join-Path $env:ProgramFiles 'obs-studio\bin\64bit\obs64.exe'
if (Test-Path -LiteralPath $obsExe) {
  if (-not (Get-Process -Name obs64 -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $obsExe -WorkingDirectory (Split-Path -Parent $obsExe)
  }
}

$port = 4317
$envFile = Join-Path $webDir '.env'
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*LIVEBRIDGE_PORT\s*=\s*"?([0-9]+)"?\s*$') { $port = [int]$Matches[1]; break }
  }
}

$health = "http://127.0.0.1:$port/health"
$ready = $false
try { $ready = (Invoke-RestMethod -Uri $health -TimeoutSec 2).ok -eq $true } catch {}
if (-not $ready) {
  Start-Process -FilePath $webExe -ArgumentList '--no-browser' -WorkingDirectory $webDir -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 40 -and -not $ready; $attempt++) {
    Start-Sleep -Milliseconds 750
    try { $ready = (Invoke-RestMethod -Uri $health -TimeoutSec 2).ok -eq $true } catch {}
  }
}
if (-not $ready) { throw 'SYNC LIVE web server did not become ready.' }

$body = '{"title":""}'
$result = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/stream/prepare" -ContentType 'application/json' -Body $body -TimeoutSec 120
if (-not $result.ok) { throw "Relay preparation failed: $($result.error)" }
Start-Process -FilePath "http://127.0.0.1:$port/"
Write-Host 'OBS and the SYNC LIVE relay are ready. Start streaming in OBS when prepared.'
