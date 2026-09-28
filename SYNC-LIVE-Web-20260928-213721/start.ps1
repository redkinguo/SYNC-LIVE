$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
  Write-Host 'Created .env. Add platform credentials there before enabling LIVE mode.' -ForegroundColor Yellow
}

$nodeExe = 'C:\Program Files\nodejs\node.exe'
$npmCmd = 'C:\Program Files\nodejs\npm.cmd'
if (-not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath $npmCmd)) {
  throw 'Install Node.js 20+ in C:\Program Files\nodejs.'
}

if (-not (Test-Path -LiteralPath 'node_modules/tiktok-live-connector') -or -not (Test-Path -LiteralPath 'node_modules/obs-websocket-js') -or -not (Test-Path -LiteralPath 'node_modules/youtube-chat')) {
  & $npmCmd install
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
}

$kickTokenConfigured = $false
foreach ($line in Get-Content -LiteralPath '.env') {
  if ($line -match '^\s*KICK_ACCESS_TOKEN\s*=\s*(.*?)\s*$') {
    $candidateToken = $Matches[1].Trim().Trim('"').Trim("'")
    if ($candidateToken -and $candidateToken -notmatch '^(?i:your_|replace|changeme)') {
      $kickTokenConfigured = $true
    }
  }
}

if ($kickTokenConfigured) {
  try {
    & (Join-Path $PSScriptRoot 'ensure-kick-fixed-webhook.ps1')
  } catch {
    $env:KICK_WEBHOOK_PUBLIC_URL = ''
    Write-Warning 'Kick HTTPS webhook could not start. SYNC LIVE will open without Kick comments.'
  }
}

& $nodeExe server.mjs
