using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace SyncLiveWeb;

internal sealed class ChatConnections : IDisposable
{
    private readonly EnvFile env;
    private readonly OAuthService oauth;
    private readonly BridgeState state;
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private readonly ConcurrentDictionary<string, CancellationTokenSource> loops = new();
    private readonly HashSet<string> kickIds = [];
    private RSA? kickKey;
    public ChatConnections(EnvFile env, BridgeState state, OAuthService oauth) { this.env = env; this.state = state; this.oauth = oauth; }

    public async Task<string> Connect(string platform, string handle)
    {
        if (loops.ContainsKey(platform)) return "接続中";
        if (platform == "twitch")
        {
            var token = (await oauth.FreshToken("twitch")).Replace("oauth:", "", StringComparison.OrdinalIgnoreCase).Trim();
            var nick = env.Get("TWITCH_USERNAME").Trim().ToLowerInvariant();
            var channel = (string.IsNullOrWhiteSpace(handle) ? env.Get("TWITCH_CHANNEL") : handle).Trim().TrimStart('#').ToLowerInvariant();
            if (token.Length == 0 || nick.Length == 0 || channel.Length == 0)
                throw new InvalidOperationException("TWITCH_ACCESS_TOKEN / TWITCH_USERNAME / TWITCH_CHANNEL を .env に設定してください");
            var cancellation = new CancellationTokenSource();
            if (!loops.TryAdd(platform, cancellation)) { cancellation.Dispose(); return "接続中"; }
            _ = TwitchLoop(token, nick, channel, cancellation.Token);
            return "#" + channel;
        }
        if (platform == "kick")
        {
            var webhook = env.Get("KICK_WEBHOOK_PUBLIC_URL").TrimEnd('/');
            var token = await oauth.FreshToken("kick");
            if (!Uri.TryCreate(webhook, UriKind.Absolute, out var uri) || uri.Scheme != "https" || token.Length == 0)
                throw new InvalidOperationException("Kick の公開 HTTPS Webhook URL とアクセストークンを .env に設定してください");
            await EnsureKickSubscription(token);
            state.SetConnected(platform, true, $"Webhook 待機中: {webhook}/webhooks/kick");
            return "Kick EventSub Webhook を待機中";
        }
        if (platform == "youtube")
        {
            if (!state.Stream.Running) throw new InvalidOperationException("YouTubeコメントは配信開始後に接続します");
            var broadcast = env.Get("YOUTUBE_BROADCAST_ID");
            var channel = env.Get("YOUTUBE_CHANNEL_ID");
            if (broadcast.Length == 0 && channel.Length == 0) throw new InvalidOperationException("YouTubeのチャンネルIDまたは配信枠IDを設定してください");
            var cancellation = new CancellationTokenSource();
            if (!loops.TryAdd(platform, cancellation)) { cancellation.Dispose(); return "接続中"; }
            _ = YouTubeLoop(broadcast, cancellation.Token);
            return "YouTubeコメント接続中";
        }
        throw new ArgumentException("配信先を確認してください");
    }

    public void Disconnect(string platform)
    {
        if (loops.TryRemove(platform, out var cancellation)) { cancellation.Cancel(); cancellation.Dispose(); }
        state.SetConnected(platform, false, "切断");
    }

    private async Task TwitchLoop(string token, string nick, string channel, CancellationToken cancellation)
    {
        var retry = 5000;
        while (!cancellation.IsCancellationRequested)
        {
            try
            {
                token = (await oauth.FreshToken("twitch")).Replace("oauth:", "", StringComparison.OrdinalIgnoreCase).Trim();
                cancellation.ThrowIfCancellationRequested();
                using var socket = new ClientWebSocket();
                await socket.ConnectAsync(new Uri("wss://irc-ws.chat.twitch.tv:443"), cancellation);
                await Send(socket, "CAP REQ :twitch.tv/tags twitch.tv/commands\r\nPASS oauth:" + token + "\r\nNICK " + nick + "\r\nJOIN #" + channel + "\r\n", cancellation);
                retry = 5000;
                var buffer = new byte[16384];
                var pending = "";
                while (socket.State == WebSocketState.Open && !cancellation.IsCancellationRequested)
                {
                    var result = await socket.ReceiveAsync(buffer, cancellation);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                    pending += Encoding.UTF8.GetString(buffer, 0, result.Count);
                    var lines = pending.Split("\r\n"); pending = lines[^1];
                    foreach (var line in lines[..^1])
                    {
                        cancellation.ThrowIfCancellationRequested();
                        if (line.StartsWith("PING ")) { await Send(socket, "PONG " + line[5..] + "\r\n", cancellation); continue; }
                        if (line.Contains(" 001 ", StringComparison.Ordinal)) state.SetConnected("twitch", true, "#" + channel);
                        if (line.Contains("Login authentication failed", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Twitchの再認証が必要です");
                        var index = line.IndexOf(" PRIVMSG #", StringComparison.Ordinal);
                        if (index < 0) continue;
                        var body = line.IndexOf(" :", index, StringComparison.Ordinal);
                        if (body < 0) continue;
                        var prefix = line.StartsWith('@') ? line[1..line.IndexOf(' ')] : "";
                        var tags = prefix.Split(';', StringSplitOptions.RemoveEmptyEntries).Select(x => x.Split('=', 2)).Where(x => x.Length == 2).ToDictionary(x => x[0], x => x[1]);
                        var user = tags.GetValueOrDefault("display-name") ?? line.Split('!')[0].TrimStart(':');
                        user = user.Replace("\\s", " ").Replace("\\:", ";").Replace("\\\\", "\\");
                        state.Publish("twitch", user, line[(body + 2)..]);
                    }
                }
            }
            catch (Exception ex) when (ex is WebSocketException or IOException or OperationCanceledException or HttpRequestException or InvalidOperationException) { }
            if (cancellation.IsCancellationRequested) break;
            state.SetConnected("twitch", false, "再接続中");
            try { await Task.Delay(retry, cancellation); } catch (OperationCanceledException) { break; }
            retry = Math.Min(60000, retry * 2);
        }
    }

    private static Task Send(ClientWebSocket socket, string line, CancellationToken cancellation) =>
        socket.SendAsync(Encoding.UTF8.GetBytes(line), WebSocketMessageType.Text, true, cancellation);

    private async Task YouTubeLoop(string broadcastId, CancellationToken cancellation)
    {
        var retry = 5000;
        while (!cancellation.IsCancellationRequested)
        {
            try
            {
                await YouTubeChatReader.Read(http, env.Get("YOUTUBE_CHANNEL_ID"), broadcastId,
                    (user, text) => { if (!cancellation.IsCancellationRequested) state.Publish("youtube", user, text); },
                    () => { if (!cancellation.IsCancellationRequested) state.SetConnected("youtube", true, "YouTubeコメント受信中 · 非公式接続"); retry = 5000; }, cancellation);
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { break; }
            catch (Exception)
            {
                if (cancellation.IsCancellationRequested) break;
                state.SetConnected("youtube", false, "YouTubeコメントを再接続しています");
                try { await Task.Delay(retry, cancellation); } catch (OperationCanceledException) { break; }
                retry = Math.Min(60000, retry * 2);
            }
        }
    }
    private async Task EnsureKickSubscription(string token)
    {
        using var listed = new HttpRequestMessage(HttpMethod.Get, "https://api.kick.com/public/v1/events/subscriptions");
        listed.Headers.Authorization = new("Bearer", token);
        using var listResponse = await http.SendAsync(listed);
        if (!listResponse.IsSuccessStatusCode) throw new InvalidOperationException($"Kickの購読状況を取得できません (HTTP {(int)listResponse.StatusCode})");
        using var list = JsonDocument.Parse(await listResponse.Content.ReadAsStringAsync());
        var exists = list.RootElement.TryGetProperty("data", out var entries) && entries.EnumerateArray().Any(item => item.TryGetProperty("event", out var type) && type.GetString() == "chat.message.sent");
        if (exists) return;
        using var created = new HttpRequestMessage(HttpMethod.Post, "https://api.kick.com/public/v1/events/subscriptions");
        created.Headers.Authorization = new("Bearer", token);
        created.Content = new StringContent("{\"method\":\"webhook\",\"events\":[{\"name\":\"chat.message.sent\",\"version\":1}]}", Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(created);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"Kickのコメント購読を作成できません (HTTP {(int)response.StatusCode})");
    }

    public async Task<IResult> KickWebhook(HttpRequest request)
    {
        using var input = new MemoryStream();
        await request.Body.CopyToAsync(input);
        if (input.Length > 1024 * 1024) return Results.BadRequest("Request body too large");
        var messageId = request.Headers["Kick-Event-Message-Id"].ToString();
        var timestamp = request.Headers["Kick-Event-Message-Timestamp"].ToString();
        var signature = request.Headers["Kick-Event-Signature"].ToString();
        if (messageId.Length == 0 || timestamp.Length == 0 || signature.Length == 0) return Results.Unauthorized();
        kickKey ??= await GetKickKey();
        var signed = Encoding.UTF8.GetBytes(messageId + "." + timestamp + "." + Encoding.UTF8.GetString(input.ToArray()));
        bool valid;
        try { valid = kickKey.VerifyData(signed, Convert.FromBase64String(signature), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1); }
        catch (FormatException) { valid = false; }
        if (!valid) return Results.Unauthorized();
        lock (kickIds) { if (!kickIds.Add(messageId)) return Results.Text("Duplicate"); if (kickIds.Count > 5000) kickIds.Clear(); }
        if (request.Headers["Kick-Event-Type"] == "chat.message.sent")
        {
            using var payload = JsonDocument.Parse(input.ToArray());
            var root = payload.RootElement;
            var user = root.GetProperty("sender").GetProperty("username").GetString() ?? "Kick user";
            var text = root.GetProperty("content").GetString() ?? "";
            state.Publish("kick", user, text);
            state.SetConnected("kick", true, "Webhook 受信中");
        }
        return Results.Text("OK");
    }

    private async Task<RSA> GetKickKey()
    {
        using var response = await http.GetAsync("https://api.kick.com/public/v1/public-key");
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = document.RootElement;
        var data = root.TryGetProperty("data", out var item) ? item : root;
        var key = data.TryGetProperty("public_key", out var raw) ? raw.GetString() : data.TryGetProperty("publicKey", out var camel) ? camel.GetString() : null;
        if (string.IsNullOrWhiteSpace(key)) throw new InvalidOperationException("Kick public key が見つかりません");
        var rsa = RSA.Create();
        rsa.ImportFromPem(key.Contains("BEGIN PUBLIC KEY") ? key : "-----BEGIN PUBLIC KEY-----\n" + key + "\n-----END PUBLIC KEY-----");
        return rsa;
    }

    public void Dispose()
    {
        foreach (var platform in loops.Keys) Disconnect(platform);
        kickKey?.Dispose();
        http.Dispose();
    }
}
