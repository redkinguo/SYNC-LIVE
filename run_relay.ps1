$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$exe = Join-Path $PSScriptRoot 'dist\Relay\OBS-Multistream-Relay.exe'
if (-not (Test-Path -LiteralPath $exe)) { & (Join-Path $PSScriptRoot 'build_relay.ps1') }
Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
