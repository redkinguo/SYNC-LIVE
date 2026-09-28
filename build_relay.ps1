$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$project = Join-Path $PSScriptRoot 'src\ObsMultistreamRelay\ObsMultistreamRelay.csproj'
$output = Join-Path $PSScriptRoot 'dist\Relay'
dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $output
if ($LASTEXITCODE -ne 0) { throw 'C# build failed.' }

$legacyConfig = Join-Path $PSScriptRoot 'config.json'
if (-not (Test-Path -LiteralPath $legacyConfig)) {
  $legacyConfig = Join-Path $PSScriptRoot 'data\legacy-relay-config.json'
}
$newConfig = Join-Path $output 'config.json'
if ((Test-Path -LiteralPath $legacyConfig) -and -not (Test-Path -LiteralPath $newConfig)) {
  Copy-Item -LiteralPath $legacyConfig -Destination $newConfig
  Write-Host 'Migrated existing config to dist\Relay\config.json.'
}
$symbols = Join-Path $output 'OBS-Multistream-Relay.pdb'
if (Test-Path -LiteralPath $symbols) { Remove-Item -LiteralPath $symbols }
Write-Host "Built: $(Join-Path $output 'OBS-Multistream-Relay.exe')"
