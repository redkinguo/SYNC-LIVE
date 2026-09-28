# OBS Multistream Relay

OBSから受け取った映像と音声を、FFmpegで再エンコードせず複数のRTMP/RTMPS配信先に転送するWindows用アプリです。実装はC# / WinFormsです。

## 起動

`dist\Relay\OBS-Multistream-Relay.exe` をダブルクリックします。EXEがない場合は `run_relay.bat` でビルドして起動できます。ビルドには .NET 10 SDKが必要です。配布EXEには.NETランタイムが含まれます。

FFmpegはPATHに登録するか、画面の「FFmpeg」で `ffmpeg.exe` を選択してください。

## OBS設定

アプリを起動して「中継開始」を押したあと、OBSの「設定 > 配信」で次を設定します。

- サービス: `カスタム...`
- サーバー: `rtmp://127.0.0.1:1935/live`
- ストリームキー: `obs`

入力ポートやパスを変えた場合はOBS側も合わせてください。

## 配信先と設定ファイル

配信先のサーバーURLとストリームキーを入力します。ストリームキーはWindowsのユーザーアカウントに紐づくDPAPIで暗号化し、EXEと同じフォルダーの `config.json` に保存します。以前のアプリの設定は初回ビルド時に移行します。

旧設定のバックアップは `data\legacy-relay-config.json` に置いています。ビルド先を消しても、次のビルド時に設定を復元できます。

- YouTube: YouTube StudioからサーバーURLと配信キーを取得
- Kick: Creator Dashboardから取得

「異常終了時に自動再接続」を有効にすると、中継プロセス終了から5秒後に再開します。待機中の「中継停止」またはチェック解除で予約を取り消せます。

各配信先へ同じ映像と音声を送るため、配信先の数だけ上り帯域を使います。

## ビルド

```powershell
.\build_relay.ps1
```

生成先は `dist\Relay\OBS-Multistream-Relay.exe` です。

## Web版（React + C#）

`build_web.ps1` でReact画面とC#サーバーをビルドします。`dist\Web\SYNC-LIVE-Web.exe` を実行すると、ブラウザーで `http://127.0.0.1:4317` が開きます。初回のビルドにはNode.jsと.NET 10 SDKが必要ですが、EXEの実行にはどちらも不要です。

Web版の設定は `dist\Web\.env` です。まずデモモードで画面・コメント・オーバーレイを確認できます。実配信では `LIVEBRIDGE_MODE=live` とTwitch、Kick、YouTubeのRTMP URLを設定し、FFmpegをインストールしてください。OBSのサーバーは `rtmp://127.0.0.1:1935/live`、キーは `stream` です。OAuth認証は画面の「コメント／タイトル連携を設定」から行えます。TikTokは対象外です。

Web版は `run_web.bat` からも起動できます。中継アプリとWeb版を同時に使う場合は、ローカルRTMPポートが重ならないように設定してください。

`prepare_stream.bat` はOBSを開き、Web版のRTMP待機を準備してダッシュボードを表示します。実配信はOBS側の「配信開始」を押した時に始まります。

Kickのコメントを受信する場合は、公開HTTPSトンネルを `127.0.0.1:4320` に向け、その公開URLを `.env` の `KICK_WEBHOOK_PUBLIC_URL` に設定します。この専用ポートは署名付きKick WebhookのPOSTだけを受け付けます。

YouTubeコメントは旧版と同様に公開ページ経由で取得します。`YOUTUBE_CHANNEL_ID` または `YOUTUBE_BROADCAST_ID` を設定してください。コメント取得のためにYouTube Data APIをポーリングすることはありません。配信枠・タイトル・視聴者数の操作と取得にはOAuthと公式APIを使用します。

## ディレクトリ

```text
src/
  ObsMultistreamRelay/     C# WinForms中継アプリ
  SyncLiveWeb/
    Client/               React画面
    Server/               C# ASP.NET Coreサーバー
dist/
  Relay/                  中継アプリEXEと設定
  Web/                    Web版EXE・画面・設定
data/                     旧設定のバックアップ（Git管理対象外）
docs/                     移行・確認記録
```

Web版を別の場所へ配布するときは `dist\Web` フォルダー全体をコピーしてください。`wwwroot` にReactの画面ファイルがあります。配信先キーや認証情報を含む設定ファイルは公開しないでください。

移行範囲と確認内容は `docs\migration-review.md` に記載しています。
