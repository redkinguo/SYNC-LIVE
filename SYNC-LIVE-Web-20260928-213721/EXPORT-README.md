# SYNC LIVE Web管理画面のソース一式

このPCの %LOCALAPPDATA%\SYNC LIVE\app から取得したWeb管理画面です。
Python製OBS-Multistream-Relayとは別のアプリです。

- メイン画面: index.html
- サーバー: server.mjs
- コメント専用: chat-view.html
- OBSコメント表示: overlay.html
- タイトル・説明の管理: metadata-settings.html / metadata-api.mjs
- OAuth連携: oauth-setup.*
- 起動: start.ps1 または npm start

別PCで使う場合はNode.js 20以上とFFmpegを用意し、npm ciで依存関係を導入してください。
.env.exampleを.envへコピーし、FFMPEG_PATHと必要な連携情報をローカルで設定します。
初期モードはdemoです。既存PCの稼働中アプリは変更していません。

含まないもの: .env、data（保存設定・認証情報）、backups、node_modules、実機のCloudflareトンネル設定、ショートカット、FFmpeg本体、外部TikTokツール。
機種固有の自動起動・トンネル用スクリプトは移行先に合わせて設定が必要です。
認証情報の再設定なしで動く完全バックアップではありません。
