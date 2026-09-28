$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
$envFile = Join-Path $appDir '.env'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$cloudflared = (Get-Command cloudflared.exe -ErrorAction Stop).Source
$runtimeDir = Join-Path $appDir 'data'
$stateFile = Join-Path $runtimeDir 'kick-quick-tunnel.json'
$proxyPort = 4320
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

function Test-LocalListener([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $Port -ErrorAction SilentlyContinue)
}

if (-not (Test-LocalListener $proxyPort)) {
  if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'Node.js was not found.' }
  Start-Process -FilePath $nodeExe -ArgumentList 'kick-webhook-proxy.mjs' -WorkingDirectory $appDir -WindowStyle Hidden | Out-Null
  $proxyDeadline = (Get-Date).AddSeconds(15)
  while (-not (Test-LocalListener $proxyPort) -and (Get-Date) -lt $proxyDeadline) {
    Start-Sleep -Milliseconds 300
  }
  if (-not (Test-LocalListener $proxyPort)) { throw 'Kick webhook receiver did not start on port 4320.' }
}

$publicUrl = $null
$tunnelProcess = $null
if (Test-Path -LiteralPath $stateFile) {
  try {
    $saved = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $candidate = [string]$saved.Url
    $pidValue = [int]$saved.ProcessId
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
    if ($candidate -match '^https://[a-z0-9-]+\.trycloudflare\.com$' -and
        $processInfo -and $processInfo.Name -eq 'cloudflared.exe' -and
        $processInfo.CommandLine -match '--url\s+http://127\.0\.0\.1:4320') {
      $publicUrl = $candidate
      $tunnelProcess = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    }
  } catch {}
}

if (-not $publicUrl) {
  $stdoutLog = Join-Path $runtimeDir 'kick-quick-tunnel.stdout.log'
  $stderrLog = Join-Path $runtimeDir 'kick-quick-tunnel.stderr.log'
  Remove-Item -LiteralPath $stdoutLog,$stderrLog -Force -ErrorAction SilentlyContinue
  $configFile = Join-Path $appDir 'kick-quicktunnel.yml'
  $arguments = 'tunnel --config "{0}" --url http://127.0.0.1:4320 --protocol http2 --no-autoupdate' -f $configFile
  $tunnelProcess = Start-Process -FilePath $cloudflared -ArgumentList $arguments -WorkingDirectory $appDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
  $deadline = (Get-Date).AddSeconds(75)
  do {
    Start-Sleep -Milliseconds 500
    $combined = ''
    foreach ($log in @($stdoutLog,$stderrLog)) {
      if (Test-Path -LiteralPath $log) {
        try { $combined += Get-Content -LiteralPath $log -Raw } catch {}
      }
    }
    $match = [regex]::Match($combined, '(?i)https://[a-z0-9-]+\.trycloudflare\.com')
    $ready = $match.Success -and $combined -match 'Registered tunnel connection'
  } while (-not $ready -and -not $tunnelProcess.HasExited -and (Get-Date) -lt $deadline)
  if (-not $ready) {
    if (-not $tunnelProcess.HasExited) { Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue }
    throw 'Cloudflare Quick Tunnel could not connect. Check the network and try again.'
  }
  $publicUrl = $match.Value.ToLowerInvariant()
  $state = @{ ProcessId = $tunnelProcess.Id; Url = $publicUrl; StartedAt = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($stateFile, $state, [System.Text.UTF8Encoding]::new($false))
}

if (-not (Test-Path -LiteralPath $envFile)) { throw '.env was not found.' }
$content = [System.IO.File]::ReadAllText($envFile)
$lines = [regex]::Split($content, '\r?\n')
$found = $false
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match '^\s*KICK_WEBHOOK_PUBLIC_URL\s*=') {
    $lines[$i] = "KICK_WEBHOOK_PUBLIC_URL=$publicUrl"
    $found = $true
  }
}
if (-not $found) { $lines += "KICK_WEBHOOK_PUBLIC_URL=$publicUrl" }
$newContent = [string]::Join("`r`n", $lines)
[System.IO.File]::WriteAllText($envFile, $newContent, [System.Text.UTF8Encoding]::new($false))
$env:KICK_WEBHOOK_PUBLIC_URL = $publicUrl
Write-Host 'Kick webhook receiver and HTTPS tunnel are ready.'
