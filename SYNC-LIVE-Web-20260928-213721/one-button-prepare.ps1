$ErrorActionPreference = 'Stop'
$appDir = Join-Path $env:LOCALAPPDATA 'SYNC LIVE\app'
$obsExe = Join-Path $env:ProgramFiles 'obs-studio\bin\64bit\obs64.exe'
$startScript = Join-Path $appDir 'start.ps1'
$healthUrl = 'http://127.0.0.1:4318/health'
$prepareUrl = 'http://127.0.0.1:4318/api/stream/prepare'
$statusFile = Join-Path $env:LOCALAPPDATA 'SYNC LIVE\diagnostics\prepare-status.txt'

function Set-PrepareStatus([string]$value) {
  try {
    New-Item -ItemType Directory -Path (Split-Path -Parent $statusFile) -Force | Out-Null
    [System.IO.File]::WriteAllText($statusFile, ((Get-Date).ToString('s') + ' ' + $value), [System.Text.Encoding]::ASCII)
  } catch {}
}

Set-PrepareStatus 'started'

if (-not (Test-Path -LiteralPath $obsExe)) { throw 'OBS Studio was not found in the expected install location.' }
if (-not (Test-Path -LiteralPath $startScript)) { throw 'SYNC LIVE start.ps1 was not found.' }

if (-not (Get-Process -Name obs64 -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $obsExe -WorkingDirectory (Split-Path -Parent $obsExe)
}
Set-PrepareStatus 'obs-opened'

$healthy = $false
try { $healthy = (Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2).ok } catch {}
if (-not $healthy) {
  Set-PrepareStatus 'starting-sync-live'
  $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Start-Process -FilePath $powershellExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $startScript + '"')) -WindowStyle Hidden
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    try { $healthy = (Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2).ok } catch { $healthy = $false }
    if ($healthy) { break }
  }
}
if (-not $healthy) {
  Set-PrepareStatus 'failed-starting-sync-live'
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show('SYNC LIVE could not start. Tell Codex: failed-starting-sync-live', 'SYNC LIVE')
  } catch {}
  exit 1
}
Set-PrepareStatus 'sync-live-ready'

$body = @{ title = ''; startObs = $false } | ConvertTo-Json -Compress
Set-PrepareStatus 'preparing-relay'
try {
  $result = Invoke-RestMethod -Uri $prepareUrl -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 120
  if (-not $result.ok) { throw 'Relay preparation failed' }
} catch {
  Set-PrepareStatus 'failed-preparing-relay'
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show('SYNC LIVE relay preparation failed. Tell Codex: failed-preparing-relay', 'SYNC LIVE')
  } catch {}
  exit 1
}
Set-PrepareStatus 'ready'
Start-Process 'http://127.0.0.1:4318/'
Write-Output 'OBS opened (if it was closed); SYNC LIVE relay prepared. OBS streaming has not been started.'
