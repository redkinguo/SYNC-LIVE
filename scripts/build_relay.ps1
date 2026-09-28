$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$project = Join-Path $repoRoot 'src\ObsMultistreamRelay\ObsMultistreamRelay.csproj'
$output = Join-Path $repoRoot 'dist\Relay'
dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $output
if ($LASTEXITCODE -ne 0) { throw 'C# build failed.' }

$legacyConfig = Join-Path $repoRoot 'dist\Relay\config.json'
if (-not (Test-Path -LiteralPath $legacyConfig)) {
  $legacyConfig = Join-Path $repoRoot 'config.json'
}
if (-not (Test-Path -LiteralPath $legacyConfig)) {
  $legacyConfig = Join-Path $repoRoot 'data\legacy-relay-config.json'
}
$settingsDirectory = Join-Path $repoRoot 'data\Relay'
New-Item -ItemType Directory -Path $settingsDirectory -Force | Out-Null
$newConfig = Join-Path $settingsDirectory 'config.json'
if ((Test-Path -LiteralPath $legacyConfig) -and -not (Test-Path -LiteralPath $newConfig)) {
  Copy-Item -LiteralPath $legacyConfig -Destination $newConfig
  Write-Host 'Migrated existing config to data\Relay\config.json.'
}
$symbols = Join-Path $output 'OBS-Multistream-Relay.pdb'
if (Test-Path -LiteralPath $symbols) { Remove-Item -LiteralPath $symbols }
$rootExe = Join-Path $repoRoot 'OBS-Multistream-Relay.exe'
Copy-Item -LiteralPath (Join-Path $output 'OBS-Multistream-Relay.exe') -Destination $rootExe
Write-Host "Built: $rootExe"
