# OBS Multistream Relay

OBSから受け取った映像と音声を、FFmpegで再エンコードせず複数のRTMP/RTMPS配信先に転送するWindows用アプリです。実装はC# / WinFormsです。

## 起動

ルートの `OBS-Multistream-Relay.exe` をダブルクリックします。EXEがない場合は `scripts\build_relay.ps1` でビルドします。ビルドには .NET 10 SDKが必要です。配布EXEには.NETランタイムが含まれます。

FFmpegはPATHに登録するか、画面の「FFmpeg」で `ffmpeg.exe` を選択してください。

## OBS設定

アプリを起動して「中継開始」を押したあと、OBSの「設定 > 配信」で次を設定します。

- サービス: `カスタム...`
- サーバー: `rtmp://127.0.0.1:1935/live`
- ストリームキー: `obs`

入力ポートやパスを変えた場合はOBS側も合わせてください。

## 配信先と設定ファイル

配信先のサーバーURLとストリームキーを入力します。ストリームキーはWindowsのユーザーアカウントに紐づくDPAPIで暗号化し、`data\Relay\config.json` に保存します。以前のアプリの設定は初回ビルド時に移行します。

旧設定のバックアップは `data\legacy-relay-config.json` に置いています。ビルド先を消しても、次のビルド時に設定を復元できます。

- YouTube: YouTube StudioからサーバーURLと配信キーを取得
- Kick: Creator Dashboardから取得

「異常終了時に自動再接続」を有効にすると、中継プロセス終了から5秒後に再開します。待機中の「中継停止」またはチェック解除で予約を取り消せます。

各配信先へ同じ映像と音声を送るため、配信先の数だけ上り帯域を使います。

## ビルド

```powershell
.\scripts\build_relay.ps1
```

生成先はルートの `OBS-Multistream-Relay.exe` です。

## Web版（React + C#）

`scripts\build_web.ps1` でReact画面とC#サーバーをビルドします。ルートの `SYNC-LIVE-Web.exe` を実行すると、ブラウザーで `http://127.0.0.1:4317` が開きます。初回のビルドにはNode.jsと.NET 10 SDKが必要ですが、EXEの実行にはどちらも不要です。

Web版の設定は `data\Web\.env` です。まずデモモードで画面・コメント・オーバーレイを確認できます。実配信では `LIVEBRIDGE_MODE=live` とTwitch、Kick、YouTubeのRTMP URLを設定し、FFmpegをインストールしてください。OBSのサーバーは `rtmp://127.0.0.1:1935/live`、キーは `stream` です。OAuth認証は画面の「コメント／タイトル連携を設定」から行えます。TikTokは対象外です。

中継アプリとWeb版を同時に使う場合は、ローカルRTMPポートが重ならないように設定してください。

`scripts\prepare_stream.bat` はOBSを開き、Web版のRTMP待機を準備してダッシュボードを表示します。実配信はOBS側の「配信開始」を押した時に始まります。

Kickのコメントを受信する場合は、公開HTTPSトンネルを `127.0.0.1:4320` に向け、その公開URLを `.env` の `KICK_WEBHOOK_PUBLIC_URL` に設定します。この専用ポートは署名付きKick WebhookのPOSTだけを受け付けます。

YouTubeコメントは旧版と同様に公開ページ経由で取得します。`YOUTUBE_CHANNEL_ID` または `YOUTUBE_BROADCAST_ID` を設定してください。コメント取得のためにYouTube Data APIをポーリングすることはありません。配信枠・タイトル・視聴者数の操作と取得にはOAuthと公式APIを使用します。

## ディレクトリ

```text
OBS-Multistream-Relay.exe  中継アプリの起動
SYNC-LIVE-Web.exe          Web版の起動
README.md                 使い方
scripts/                  ビルド・OBS配信準備
src/
  ObsMultistreamRelay/     C# WinForms中継アプリ
  SyncLiveWeb/
    Client/               React画面
    Server/               C# ASP.NET Coreサーバー
assets/web/               Web画面の配布ファイル
data/                    設定と旧設定バックアップ（Git管理対象外）
  Relay/config.json       中継アプリ設定
  Web/.env                Web版設定
  Web/stream-descriptions.json  固定説明文
dist/                    ビルドの中間出力（起動には不要）
docs/                     移行・確認記録
```

Web版を別の場所へ移すときは、ルートの `SYNC-LIVE-Web.exe` と `assets`、`data\Web`、`THIRD-PARTY-NOTICES.txt` を同じ構成でコピーしてください。中継アプリはルートのEXEと `data\Relay` をコピーします。EXEと生成済み画面・個人設定はGit管理対象外です。配信先キーや認証情報を含む設定ファイルは公開しないでください。

移行範囲と確認内容は `docs\migration-review.md` に記載しています。
