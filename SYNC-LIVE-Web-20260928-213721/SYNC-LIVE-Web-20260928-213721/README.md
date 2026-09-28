# SYNC LIVE — ローカルマルチ配信・統合コメント試作

Windows と OBS を前提にした、日本語のローカル Web アプリです。配信タイトル同期、OBS WebSocket による配信開始・停止、OBS の RTMP 入力を FFmpeg で分配する機能、4サービスの統合コメント、OBS 映像へ重ねるコメントオーバーレイを含みます。

## 起動

1. Node.js 20 以降と FFmpeg を入れます。FFmpeg が PATH にない場合は `.env` の `FFMPEG_PATH` に実行ファイルの場所を設定します。
2. `start.ps1` を実行します。初回は `.env` を作成し、必要なパッケージをインストールします。
3. デモモードは認証情報不要で `http://127.0.0.1:4317` を開きます。

最初はデモモードです。画面の「＋」でテストコメントを流し、統合コメント画面とオーバーレイを試せます。デモモードでは外部サービスへ接続しません。

## 4 サービスへ同時配信する

`.env` の `RTMP_TWITCH`、`RTMP_KICK`、`RTMP_YOUTUBE` に配信 URL とキーを設定します。TikTok に公式 RTMP キーがある場合は `RTMP_TIKTOK` も設定できます。TikTok キーがない場合は後述の「TikTok 非公式枠作成」を設定すると、共通タイトルでLIVE枠を作成してローカル署名プロキシへ自動接続します。`LIVEBRIDGE_MODE=live` にして再起動し、画面で共通タイトルを入力して「マルチ配信を開始」を押します。設定済みのサービスだけを使い、4つを必須にする場合は `LIVEBRIDGE_REQUIRE_ALL_DESTINATIONS=true` にします。

OBS の「配信」設定はサービスを「カスタム」にし、サーバーに `rtmp://127.0.0.1:1935/live`、ストリームキーに `stream` を指定します。「ツール → WebSocket サーバー設定」で WebSocket を有効にし、パスワードを `.env` の `OBS_WS_PASSWORD` に設定します。既定の URL は `ws://127.0.0.1:4455` です。映像は再エンコードせずコピーするので負荷を抑えます。すべての配信先で同じ映像・音声形式を使います。TikTok 用に縦型レイアウトを別出力する機能はありません。

このアプリ経由だけで配信する場合、OBSの出力先は上記のローカルRTMP 1つにします。OBSのマルチRTMPプラグインやサービスごとの直接出力を同時に有効にすると、二重配信になります。1つの宛先が失敗しても他の宛先は送信を続けます。OBSからローカル入力が来ない、または共通リレーが停止した場合は全宛先が止まります。

「配信先の状態」には各サービスごとに「OBS入力待ち」「送信中」「失敗」を表示します。「送信中」はこのアプリのFFmpegからRTMP送信できている状態です。サービス側でLIVEとして公開されたことや視聴者から見えることまでは確認できないため、各サービスの配信ページでも確認してください。

### 4サービスのコメントを配信映像に出す

統合コメント欄の「オーバーレイ URL をコピー」を押し、OBS で「ソースを追加 → ブラウザ」を選んで URL を設定します。幅・高さは OBS キャンバスと同じ（例: 1920×1080）にします。オーバーレイは透過背景で受信コメントを最大7件表示し、一定時間後に消します。

### タイトルとTikTokの制約

共通タイトルは最大100文字です。Twitch の `channel:manage:broadcast`、Kick の `channel:write`、YouTube Live Streaming API の書き込み権限と配信 ID が必要です。TikTok 公式のタイトル更新 API は使わず、非公式枠API設定時には入力したタイトルを枠作成時に指定します。

### TikTok映像（Streamlabs API方式）

TikTokのストリームキーやRapidAPI署名キーが手元にない場合は、画面の「TikTok映像を設定」→「Streamlabsと連携」を押し、開いたStreamlabs画面で自分のアカウントを認証します。Streamlabs側でTikTok LIVEアクセスが有効になっている必要があります。外部の非公式なStreamlabs APIを利用し、認証情報はこのPCの `.env` に保存します。認証情報は画面・ログ・コメントに出しません。

連携後はSYNC LIVEの「マルチ配信を開始」でStreamlabs APIからTikTokの一時RTMP宛先を取得し、OBSの映像を他サービスと一緒に送ります。「マルチ配信を停止」ではTikTok LIVE枠の終了も要求します。ログイン・連携だけではLIVE枠を作らず、映像も送信しません。API仕様変更やStreamlabs/TikTokアカウントのLIVE資格によって利用できないことがあります。公開情報に基づく未公式連携であり、このPCのTikTokアカウントでの配信確認はまだ行っていません。

別の方法として、TikTokが公式にRTMPサーバーとストリームキーを表示している場合は、画面の「TikTok映像を設定」から手入力できます。この方式を保存するとStreamlabs方式から切り替わります。以前のRapidAPI署名プロキシ方式は互換性のためコードに残していますが、新しいStreamlabs連携では使いません。

公式RTMPキーを使う場合、非公式枠モードは無効にして `RTMP_TIKTOK` を指定します。TikTok LIVE Studio を使う場合は、OBS Virtual Camera などで手動配信する方式も選べます。[OBS Virtual Camera](https://obsproject.com/kb/virtual-camera-guide) [TikTok LIVE の利用条件](https://support.tiktok.com/en/live-gifts-wallet/tiktok-live/what-is-tiktok-live)

## 実チャット受信を設定する

`.env` の `LIVEBRIDGE_MODE=live` に変更して、使うサービスの認証情報を設定し、サーバーを再起動します。トークンは `.env` とローカル Node.js プロセスで扱い、画面のブラウザー保存領域には入れません。

- **Twitch:** Twitch チャンネル名は画面の「接続設定」、`TWITCH_USERNAME` と OAuth アクセストークンは `.env` に設定します。タイトル同期には `TWITCH_CLIENT_ID`、`TWITCH_BROADCASTER_ID` と `channel:manage:broadcast` を含むトークンが必要です。チャンネル説明を更新するときだけ、設定画面から追加認証して `user:edit` を許可してください。チャット読み取り権限も付与してください。
- **YouTube:** 配信枠と RTMP キーを設定します。配信開始時の枠作成・タイトル同期・自動公開には YouTube Live API と OAuth を使います。コメント本文は非公式の [`youtube-chat`](https://github.com/LinaTsukusu/youtube-chat) を使って受け取り、YouTube Data API の利用枠を消費しません。このライブラリは YouTube の非公開仕様に依存するため、仕様変更で止まる場合があります。
- **TikTok:** 画面の接続設定でユーザー名を指定し、「API 接続」を押します。受信には非公式の [`tiktok-live-connector`](https://github.com/zerodytrash/TikTok-Live-Connector) を使い、任意で `TIKTOK_SIGN_API_KEY` を設定できます。
- **Kick:** `.env` の `KICK_WEBHOOK_PUBLIC_URL` に公開 HTTPS URL を設定し、その URL の `/webhooks/kick` を Kick アプリに登録して `chat.message.sent` を購読します。タイトル同期には `channel:write` 権限の OAuth ユーザーアクセストークンを `KICK_ACCESS_TOKEN` に設定します。ローカル PC に直接 webhook は届かないため、トンネルまたはサーバーが要ります。受け取ったイベントは Kick の公開鍵で署名検証してから表示します。

設定例は `.env.example` にあります。アクセストークンや RTMP キーを GitHub などに公開しないでください。

## 配信先ごとの情報設定

ダッシュボードの「配信先ごとにタイトル・カテゴリー・タグ・サムネイルを設定」からサービス別に更新できます。YouTubeはタイトル・説明・カテゴリー・タグとサムネイル、Twitchはタイトル・カテゴリー・タグ、Kickはタイトル・カテゴリー・カスタムタグを公式APIで更新します。TwitchとKickのAPIにはカスタムサムネイルを設定する項目がないため、それぞれの管理画面で設定してください。

YouTubeの videos.update は1回50 units、サムネイル設定も1回50 unitsです。利用枠を超えたときは非公式APIで制限を回避せず、YouTube Studioで手動更新してください。YouTube公式APIの利用状況は Google Cloud Console で確認できます。

### 固定の説明文

設定画面 `/metadata` では、YouTubeの現在の配信枠の説明をこのPC内に保存し、SYNC LIVEが新規作成する今後の配信枠へ自動で使えます。固定文を保存するだけではYouTube上の既存枠を変更しません。Twitchのチャンネル説明は公式APIで更新でき、設定画面から追加認証して `user:edit` 権限を許可した場合に更新できます。Kickの公開APIはチャンネル説明の書き込みに対応していないため、固定文の保存とコピーまでを行い、Kickのチャンネル設定への貼り付けは手動です。説明設定ファイルはアプリの `data/stream-descriptions.json` に保存されます。

### 同時視聴者数と配信時間

ダッシュボードとコメント専用画面に、Twitch・Kick・YouTube・TikTokの同接と配信時間を表示します。Twitch・Kick・YouTubeの状態確認は映像送信中だけ1分ごとに行います。YouTubeの確認は `videos.list` を使うため、配信中に1分あたり1 unit（4時間で約240 units）を使います。TikTokは既存の非公式 `tiktok-live-connector` 接続から視聴者数イベントを受け取り、イベントが遅れる場合は同じ接続のルーム情報を1分ごとに補完取得します。TikTokの配信開始時刻はルーム情報に開始時刻が含まれる場合に表示します。TikTokが数値を返していない間は「同接データ待ち」と表示します。コメント専用画面は2秒ごとに同期しますが、既存コメント行を再利用して点滅を防ぎます。
## 既知の範囲

- 統合コメントはメモリ内の最新 500 件までです。
- コメント入力欄と `!help` の返答はデモ表示で、各サービスへの投稿は行いません。実チャットへの読み取り専用接続です。
- Twitch と YouTube の OAuth アクセストークンは期限切れ時に更新用トークンで更新します。YouTube API の日次利用枠は配信枠の作成・タイトル同期・自動公開に使われ、コメント取得は含まれません。利用枠超過や更新用トークンの失効は別途発生する場合があります。
- Kick の購読登録自体は Kick Developer Portal 側で行います。
- TikTok 受信は非公式 API のため、Webcast 仕様変更や署名サービスの制限で止まる場合があります。選定したコネクターのライセンスは modified AGPL です。アプリを再配布する場合は依存ライセンスへの対応が必要です。
- TikTok 枠作成アダプターは `TIKTOK_PRIVATE_API_ENABLED=true` の場合のみ動作します。参考ジェネレーターの公開 `Stream` 実装に依存し、同プロジェクトは本アプリに同梱していません。`.runtime/tiktok-sei-proxy.log` には接続診断情報が記録されるため、共有前に内容を確認してください。
- 映像出力は設定した RTMP URL に対して同一形式で送ります。TikTok の利用資格や各サービスの入力仕様はアカウントごとに確認してください。実アカウントでの配信確認は行っていません。

## API 参照

- [Twitch Chat & Chatbots](https://dev.twitch.tv/docs/chat)
- [Twitch API: Modify Channel Information](https://dev.twitch.tv/docs/api/reference/#modify-channel-information)
- [Kick API: Channels](https://docs.kick.com/apis/channels)
- [YouTube LiveBroadcasts: update](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/update)
- [OBS WebSocket](https://github.com/obsproject/obs-websocket)
- [YouTube LiveChatMessages](https://developers.google.com/youtube/v3/live/docs/liveChatMessages)
- [Kick webhook event types](https://github.com/KickEngineering/KickDevDocs/blob/main/events/event-types.md)
- [Kick webhook signature verification](https://github.com/KickEngineering/KickDevDocs/blob/main/events/webhook-security.md)
- [TikTok LIVE Connector (unofficial)](https://github.com/zerodytrash/TikTok-Live-Connector)
- [TikTokStreamKeyGenerator (unofficial; separate local checkout required)](https://github.com/Loukious/TikTokStreamKeyGenerator)
