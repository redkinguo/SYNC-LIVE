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
