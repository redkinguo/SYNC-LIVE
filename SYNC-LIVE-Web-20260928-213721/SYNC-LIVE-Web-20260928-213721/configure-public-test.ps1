$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$envFile = Join-Path $appRoot '.env'
if (-not (Test-Path -LiteralPath $envFile)) { throw 'SYNC LIVE の .env が見つかりません。先に start.ps1 を一度起動してください。' }

function Read-SecretText([string]$prompt) {
  $secure = Read-Host $prompt -AsSecureString
  if ($null -eq $secure -or $secure.Length -eq 0) { throw '空欄の値があるため、設定を保存しませんでした。' }
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

Write-Host '各キーは入力中に伏字で表示されます。入力後、配信は開始されません。' -ForegroundColor Cyan
$youtubeKey = Read-SecretText 'YouTube 配信キー'
$twitchKey = Read-SecretText 'Twitch 配信キー'
$kickKey = Read-SecretText 'Kick 配信キー'
foreach ($value in @($youtubeKey, $twitchKey, $kickKey)) {
  if ($value -match '[\r\n"]') { throw 'キーに使用できない文字が含まれています。設定を保存しませんでした。' }
}

$updates = [ordered]@{
  LIVEBRIDGE_MODE = 'live'
  LIVEBRIDGE_REQUIRE_ALL_DESTINATIONS = 'false'
  RTMP_YOUTUBE = "rtmp://a.rtmp.youtube.com/live2/$youtubeKey"
  RTMP_TWITCH = "rtmp://live.twitch.tv/app/$twitchKey"
  RTMP_KICK = "rtmps://fa723fc1b171.global-contribute.live-video.net/$kickKey"
}
$names = @($updates.Keys)
$pattern = '^\s*(' + (($names | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')\s*='
$seen = @{}
$lines = [System.Collections.Generic.List[string]]::new()
foreach ($line in [IO.File]::ReadAllLines($envFile)) {
  if ($line -match $pattern) {
    $name = $matches[1]
    if (-not $seen.ContainsKey($name)) {
      $lines.Add($name + '="' + $updates[$name] + '"')
      $seen[$name] = $true
    }
  } else {
    $lines.Add($line)
  }
}
foreach ($name in $names) {
  if (-not $seen.ContainsKey($name)) { $lines.Add($name + '="' + $updates[$name] + '"') }
}
[IO.File]::WriteAllText($envFile, ($lines -join "`r`n") + "`r`n", [Text.UTF8Encoding]::new($false))
$youtubeKey = $null; $twitchKey = $null; $kickKey = $null; $updates = $null
Write-Host '3サービスの宛先を保存しました。配信はまだ開始していません。' -ForegroundColor Green
Write-Host 'SYNC LIVE と OBS を準備してから、アプリ画面で「マルチ配信を開始」を押してください。' -ForegroundColor Yellow