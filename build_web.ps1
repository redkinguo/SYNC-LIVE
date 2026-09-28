$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$client = Join-Path $PSScriptRoot 'src\SyncLiveWeb\Client'
$server = Join-Path $PSScriptRoot 'src\SyncLiveWeb\Server\SyncLiveWeb.csproj'
$output = Join-Path $PSScriptRoot 'dist\Web'

Push-Location $client
try {
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'React dependency installation failed.' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'React build failed.' }
} finally { Pop-Location }

dotnet publish $server -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $output
if ($LASTEXITCODE -ne 0) { throw 'C# web server build failed.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD-PARTY-NOTICES.txt') -Destination $output

$oldEnv = Join-Path $PSScriptRoot 'src\SyncLiveWeb\Server\.env'
$newEnv = Join-Path $output '.env'
if (-not (Test-Path -LiteralPath $newEnv)) {
  if (Test-Path -LiteralPath $oldEnv) { Copy-Item -LiteralPath $oldEnv -Destination $newEnv }
  else { Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'src\SyncLiveWeb\Server\.env.example') -Destination $newEnv }
}
foreach ($extra in @('SYNC-LIVE-Web.pdb', 'SYNC-LIVE-Web.staticwebassets.endpoints.json', 'web.config')) {
  $path = Join-Path $output $extra
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
}
$sourceAssets = Join-Path $PSScriptRoot 'src\SyncLiveWeb\Server\wwwroot\assets'
$publishedAssets = Join-Path $output 'wwwroot\assets'
if (Test-Path -LiteralPath $publishedAssets) {
  foreach ($asset in Get-ChildItem -LiteralPath $publishedAssets -File) {
    $sourceName = $asset.Name -replace '\.(br|gz)$', ''
    if (-not (Test-Path -LiteralPath (Join-Path $sourceAssets $sourceName))) {
      Remove-Item -LiteralPath $asset.FullName
    }
  }
}
Write-Host "Built: $(Join-Path $output 'SYNC-LIVE-Web.exe')"
