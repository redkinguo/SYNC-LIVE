# OBS Multistream Relay

OBSから受け取った配信を、複数のRTMP/RTMPS配信先へ同時に転送するWindows向けMVPです。

このアプリは配信映像を再エンコードせず、そのまま転送します。そのためローカルPCの負荷は比較的小さくなりますが、配信先の数だけ上り回線を使います。

## 必要なもの

- Windows 10/11
- Python 3.10以降
- FFmpeg（`ffmpeg.exe`をPATHに登録するか、アプリ画面で実行ファイルを指定）
- YouTube、Kick、TikTok LIVEの配信キー

## 起動

`run_relay.bat`をダブルクリックするか、次のコマンドで起動します。

```powershell
python .\relay_app.py
```

FFmpegがPATHに登録されていない場合は、画面の「FFmpeg」で`ffmpeg.exe`を指定してください。

## OBS設定

アプリを先に起動して「中継開始」を押したあと、OBSの「設定 > 配信」で以下を設定します。

- サービス: `カスタム...`
- サーバー: `rtmp://127.0.0.1:1935/live`
- ストリームキー: `obs`

アプリの入力ポートやパスを変更した場合は、OBS側も同じ値に変更してください。

## 配信先設定

配信先のサーバーURLとストリームキーを入力します。キーはWindowsのユーザーアカウントに紐づくDPAPIで暗号化して保存します。

- YouTube: YouTube Studioのライブ管理画面からサーバーURLと配信キーを取得
- Kick: Creator Dashboardの「Stream URL and Key」から取得
- TikTok: TikTok LIVE側でRTMP配信が利用できるアカウントのサーバーURLと配信キーを取得

このMVPでは、OBSから来た同じ解像度・同じ映像を各配信先へ転送します。TikTok用だけ縦型にする、配信先ごとに解像度を変える、といった処理は次の拡張で対応します。

## 注意

- KickやTikTokはアカウント状態によって利用できる解像度やRTMP配信機能が異なる場合があります。
- 1080p・6Mbpsを3配信先へ送る場合、上り帯域は少なくとも18Mbps程度必要です。
- 配信キーは他人に見せないでください。漏えいした場合は各サービス側でキーを再発行してください。
