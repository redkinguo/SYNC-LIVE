$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$cloudflared = (Get-Command cloudflared.exe -ErrorAction Stop).Source
$runtimeDir = Join-Path $appDir 'data'
$tunnelId = 'd081fe4f-2572-477d-a266-c5b7308fb00f'
$publicUrl = 'https://synclive-kick.zettai-red.com'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

function Test-LocalListener([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $Port -ErrorAction SilentlyContinue)
}

if (-not (Test-LocalListener 4320)) {
  Start-Process -FilePath $nodeExe -ArgumentList 'kick-webhook-proxy.mjs' -WorkingDirectory $appDir -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds(15)
  while (-not (Test-LocalListener 4320) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  if (-not (Test-LocalListener 4320)) { throw 'Kick webhook receiver did not start.' }
}

$existing = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($tunnelId) }
if (-not $existing) {
  $configFile = Join-Path $appDir 'kick-tunnel.yml'
  $arguments = 'tunnel --config "{0}" --no-autoupdate run {1}' -f $configFile,$tunnelId
  Start-Process -FilePath $cloudflared -ArgumentList $arguments -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'kick-tunnel.stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'kick-tunnel.stderr.log') | Out-Null
}

# A fixed hostname keeps Kick's saved webhook valid across PC restarts.
$deadline = (Get-Date).AddSeconds(60)
$ready = $false
do {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$publicUrl/webhooks/kick" -TimeoutSec 5 -ErrorAction Stop | Out-Null
  } catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { $ready = $true }
  }
  if (-not $ready) { Start-Sleep -Seconds 1 }
} while (-not $ready -and (Get-Date) -lt $deadline)
if (-not $ready) { throw 'Kick HTTPS tunnel is not ready. Check the connection.' }

$envFile = Join-Path $appDir '.env'
$contents = [IO.File]::ReadAllText($envFile)
if ($contents -match '(?m)^KICK_WEBHOOK_PUBLIC_URL=') {
  $contents = [regex]::Replace($contents, '(?m)^KICK_WEBHOOK_PUBLIC_URL=[^\r\n]*', "KICK_WEBHOOK_PUBLIC_URL=$publicUrl")
} else { $contents += "`r`nKICK_WEBHOOK_PUBLIC_URL=$publicUrl`r`n" }
$temporary = "$envFile.kick-tunnel.tmp"
[IO.File]::WriteAllText($temporary, $contents, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $envFile -Force
$env:KICK_WEBHOOK_PUBLIC_URL = $publicUrl
Write-Host 'Kick webhook receiver and fixed HTTPS tunnel are ready.'
