# C# / React 移行の確認記録

## 移行範囲

| 旧機能 | 移行先 |
| --- | --- |
| RTMP受信、複数配信先へのコピー転送 | WinForms RelayWorker / Web StreamRelay |
| 配信先の追加削除、キーのマスク、設定保存 | RelayForm / RelayConfig |
| Windows DPAPIによるキー保護 | RelayConfig（旧設定形式も読み込み可能） |
| 終了後5秒で再接続、停止・チェック解除による予約取消 | RelayForm |
| ダッシュボード、統合コメント、フィルター、検索 | React main.jsx |
| コメント専用画面、自動スクロール、OBS透明オーバーレイ | React ChatView / Overlay |
| Twitch IRC、Kick署名付きWebhook、YouTube公開ページコメント | ChatConnections / YouTubeChatReader |
| OAuth認証・トークン更新、配信枠選択 | OAuthService / React OAuth |
| 共通タイトル、カテゴリー、タグ、説明、サムネイル | TitleService / MetadataService / React Metadata |
| YouTube公開枠の準備、超低遅延、自動開始 | YouTubeBroadcastService |
| 同時視聴者数、配信時間 | AudienceService |
| OBS WebSocket開始・停止 | ObsControl |
| OBS・Webサーバー・中継待機の準備 | prepare_stream.ps1 |

TikTok機能はユーザー指定により削除。旧Web版の重複コピー、旧ZIP、旧言語のソース・テスト・ビルド定義も削除。

## 静的確認で修正した事項

- 中継の開始処理を直列化し、配信先検証をYouTube枠の準備より前に実行。
- 古いFFmpegプロセスの終了通知や再待機予約が、新しい配信状態を上書きしないよう管理。
- デモモードの停止操作によるOBSへの接続を抑止。
- Web EXEの画面ファイルの基準位置をEXE所在フォルダーに固定。
- YouTube更新リクエストから読み取り専用の項目を除外。
- SSEのタイムアウト処理、購読キューの上限、停止後の視聴者数更新を修正。
- 設定値の型確認、設定ファイルの一時ファイル経由の保存を追加。
- コメント専用画面の検索・配信先フィルターと追従スクロールを復元。

## 確認の範囲

最新の修正はソースの静的確認とC#・Reactのビルドで確認。ユーザー指定に従い、コンピュータユーズによる追加確認は行っていません。

移行途中にはEXE起動、ローカルHTTP応答、デモコメント、署名なしWebhookの拒否、ローカルFFmpeg待機・停止を確認しました。最終修正版の実アカウント配信、OAuth同意、外部コメント受信、OBS操作、画面の目視比較は未確認です。静的確認だけでは外部サービスを含む完全な動作一致を保証できません。

YouTube公開ページコメントの取得方式は旧版に合わせています。非公式の接続方式のため、YouTube側のページ・内部通信形式が変わると修正が必要になります。

## 参照資料

- [旧版が使用していた youtube-chat](https://github.com/LinaTsukusu/youtube-chat)（ライセンスはルートのTHIRD-PARTY-NOTICES.txt）
- [YouTube liveBroadcasts.update](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/update)
- [YouTube videos.update](https://developers.google.com/youtube/v3/docs/videos/update)
- [OBS WebSocket protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md)
