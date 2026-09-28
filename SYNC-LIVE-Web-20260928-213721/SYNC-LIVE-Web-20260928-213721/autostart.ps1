$ErrorActionPreference = 'Stop'
$appDir = Join-Path $env:LOCALAPPDATA 'SYNC LIVE\app'
$startScript = Join-Path $appDir 'start.ps1'
$envFile = Join-Path $appDir '.env'
$diagnosticsDir = Join-Path $env:LOCALAPPDATA 'SYNC LIVE\diagnostics'
$logFile = Join-Path $diagnosticsDir 'autostart.log'
$port = 4317

function Write-AutostartLog([string]$event) {
  try {
    New-Item -ItemType Directory -Path $diagnosticsDir -Force | Out-Null
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $event
    Add-Content -LiteralPath $logFile -Value $line -Encoding ASCII
  } catch {}
}

try {
  if (-not (Test-Path -LiteralPath $startScript) -or -not (Test-Path -LiteralPath $envFile)) {
    Write-AutostartLog 'startup_failed required_file_missing'
    exit 1
  }

  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*LIVEBRIDGE_PORT\s*=\s*"?([0-9]+)"?\s*$') { $port = [int]$Matches[1]; break }
  }

  $url = "http://127.0.0.1:$port/"
  $healthUrl = "http://127.0.0.1:$port/health"
  $ready = $false
  try { $ready = (Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2).ok -eq $true } catch {}

  if (-not $ready) {
    Write-AutostartLog 'server_start_requested'
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $startScript
    $launcher = Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory $appDir -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(120)
    do {
      Start-Sleep -Milliseconds 750
      try { $ready = (Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2).ok -eq $true } catch { $ready = $false }
      if (-not $ready -and $launcher.HasExited) {
        Write-AutostartLog ('server_launcher_exited code=' + $launcher.ExitCode)
        break
      }
    } while (-not $ready -and (Get-Date) -lt $deadline)
  }

  if (-not $ready) {
    Write-AutostartLog 'startup_failed server_not_ready'
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [void][System.Windows.Forms.MessageBox]::Show("SYNC LIVEを起動できませんでした。診断ログ: $logFile", 'SYNC LIVE')
    } catch {}
    exit 1
  }

  Write-AutostartLog 'server_ready'
  Start-Process -FilePath $url
  Write-AutostartLog 'management_page_opened'
} catch {
  Write-AutostartLog ('startup_failed exception=' + $_.Exception.GetType().Name)
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show("SYNC LIVEの自動起動に失敗しました。診断ログ: $logFile", 'SYNC LIVE')
  } catch {}
  exit 1
}
