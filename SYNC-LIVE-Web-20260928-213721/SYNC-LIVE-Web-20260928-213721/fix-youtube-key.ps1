$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'SYNC LIVE - YouTube stream key'
$envFile = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path -LiteralPath $envFile)) { throw '.env が見つかりません。' }
Write-Host 'YouTube Studio の「ストリームキー」をコピーして入力してください。RTMP URL は入力しないでください。' -ForegroundColor Cyan
$secure = Read-Host 'YouTube ストリームキー' -AsSecureString
if ($null -eq $secure -or $secure.Length -eq 0) { throw 'キーが空欄です。保存しませんでした。' }
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $youtubeKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if (-not $youtubeKey -or $youtubeKey -match '://|[/\\]|\s|["'']') { throw '入力された値はストリームキーではありません。YouTube Studio の「ストリームキー」欄の「コピー」を押してください。' }
$target = 'RTMP_YOUTUBE="rtmp://a.rtmp.youtube.com/live2/' + $youtubeKey + '"'
$lines = [System.Collections.Generic.List[string]]::new()
$found = $false
foreach ($line in [IO.File]::ReadAllLines($envFile)) {
  if ($line -match '^\s*RTMP_YOUTUBE\s*=') {
    if (-not $found) { $lines.Add($target); $found = $true }
  } else { $lines.Add($line) }
}
if (-not $found) { $lines.Add($target) }
[IO.File]::WriteAllText($envFile, ($lines -join "`r`n") + "`r`n", [Text.UTF8Encoding]::new($false))
$youtubeKey = $null; $target = $null
Write-Host 'YouTube ストリームキーを保存しました。SYNC LIVE の再起動が必要です。' -ForegroundColor Green