$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$client = Join-Path $repoRoot 'src\SyncLiveWeb\Client'
$server = Join-Path $repoRoot 'src\SyncLiveWeb\Server\SyncLiveWeb.csproj'
$output = Join-Path $repoRoot 'dist\Web'

Push-Location $client
try {
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'React dependency installation failed.' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'React build failed.' }
} finally { Pop-Location }

dotnet publish $server -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $output
if ($LASTEXITCODE -ne 0) { throw 'C# web server build failed.' }
Copy-Item -LiteralPath (Join-Path $repoRoot 'THIRD-PARTY-NOTICES.txt') -Destination $output

$oldEnv = Join-Path $output '.env'
if (-not (Test-Path -LiteralPath $oldEnv)) { $oldEnv = Join-Path $repoRoot 'src\SyncLiveWeb\Server\.env' }
$settingsDirectory = Join-Path $repoRoot 'data\Web'
New-Item -ItemType Directory -Path $settingsDirectory -Force | Out-Null
$newEnv = Join-Path $settingsDirectory '.env'
if (-not (Test-Path -LiteralPath $newEnv)) {
  if (Test-Path -LiteralPath $oldEnv) { Copy-Item -LiteralPath $oldEnv -Destination $newEnv }
  else { Copy-Item -LiteralPath (Join-Path $repoRoot 'src\SyncLiveWeb\Server\.env.example') -Destination $newEnv }
}
foreach ($extra in @('SYNC-LIVE-Web.pdb', 'SYNC-LIVE-Web.staticwebassets.endpoints.json', 'web.config')) {
  $path = Join-Path $output $extra
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
}
$sourceAssets = Join-Path $repoRoot 'src\SyncLiveWeb\Server\wwwroot\assets'
$publishedAssets = Join-Path $output 'wwwroot\assets'
if (Test-Path -LiteralPath $publishedAssets) {
  foreach ($asset in Get-ChildItem -LiteralPath $publishedAssets -File) {
    $sourceName = $asset.Name -replace '\.(br|gz)$', ''
    if (-not (Test-Path -LiteralPath (Join-Path $sourceAssets $sourceName))) {
      Remove-Item -LiteralPath $asset.FullName
    }
  }
}
$oldDescriptions = Join-Path $output 'data\stream-descriptions.json'
$newDescriptions = Join-Path $settingsDirectory 'stream-descriptions.json'
if ((Test-Path -LiteralPath $oldDescriptions) -and -not (Test-Path -LiteralPath $newDescriptions)) {
  Copy-Item -LiteralPath $oldDescriptions -Destination $newDescriptions
}
$webAssets = Join-Path $repoRoot 'assets\web'
New-Item -ItemType Directory -Path $webAssets -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $output 'wwwroot') | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $webAssets -Recurse -Force
}
$rootAssets = Join-Path $webAssets 'assets'
foreach ($asset in Get-ChildItem -LiteralPath $rootAssets -File) {
  if (-not (Test-Path -LiteralPath (Join-Path $publishedAssets $asset.Name))) { Remove-Item -LiteralPath $asset.FullName }
}
$rootExe = Join-Path $repoRoot 'SYNC-LIVE-Web.exe'
Copy-Item -LiteralPath (Join-Path $output 'SYNC-LIVE-Web.exe') -Destination $rootExe
Write-Host "Built: $rootExe"
