using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SyncLiveWeb;

// C# implementation of the public-page protocol used by youtube-chat.
// See THIRD-PARTY-NOTICES.txt for the original project's license.
internal static class YouTubeChatReader
{
    public static async Task Read(HttpClient http, string channelId, string broadcastId,
        Action<string, string> publish, Action connected, CancellationToken cancellation)
    {
        var url = channelId.Length > 0
            ? "https://www.youtube.com/channel/" + Uri.EscapeDataString(channelId) + "/live"
            : "https://www.youtube.com/watch?v=" + Uri.EscapeDataString(broadcastId);
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.UserAgent.ParseAdd("Mozilla/5.0");
        using var response = await http.SendAsync(request, cancellation);
        response.EnsureSuccessStatusCode();
        var page = await response.Content.ReadAsStringAsync(cancellation);
        var apiKey = ExtractString(page, "INNERTUBE_API_KEY");
        var version = ExtractString(page, "INNERTUBE_CLIENT_VERSION", false);
        if (version.Length == 0) version = ExtractString(page, "clientVersion");
        using var initial = InitialData(page);
        var renderer = Find(initial.RootElement, "liveChatRenderer") ?? throw new InvalidOperationException("YouTubeのLIVEコメントがまだ利用できません");
        if (renderer.TryGetProperty("isReplay", out var replay) && replay.ValueKind == JsonValueKind.True)
            throw new InvalidOperationException("YouTubeの配信は終了しています");
        var continuation = Continuation(renderer);
        // The second menu entry is unfiltered live chat (the first is top chat).
        var menu = Find(renderer, "subMenuItems");
        if (menu is { ValueKind: JsonValueKind.Array } items && items.GetArrayLength() > 1)
        {
            var unfiltered = Continuation(items[1]);
            if (unfiltered.Length > 0) continuation = unfiltered;
        }
        var seen = new HashSet<string>();
        var order = new Queue<string>();
        while (!cancellation.IsCancellationRequested)
        {
            if (continuation.Length == 0) throw new InvalidOperationException("YouTubeコメントの接続情報が見つかりません");
            using var poll = await http.PostAsJsonAsync("https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=" + Uri.EscapeDataString(apiKey),
                new { context = new { client = new { clientName = "WEB", clientVersion = version } }, continuation }, cancellation);
            poll.EnsureSuccessStatusCode();
            using var data = JsonDocument.Parse(await poll.Content.ReadAsStringAsync(cancellation));
            var chat = Find(data.RootElement, "liveChatContinuation") ?? throw new InvalidOperationException("YouTubeコメントを再接続しています");
            cancellation.ThrowIfCancellationRequested();
            connected();
            if (chat.TryGetProperty("actions", out var actions))
            {
                foreach (var action in actions.EnumerateArray())
                {
                    if (!action.TryGetProperty("addChatItemAction", out var added) || !added.TryGetProperty("item", out var item)) continue;
                    foreach (var kind in new[] { "liveChatTextMessageRenderer", "liveChatPaidMessageRenderer", "liveChatPaidStickerRenderer", "liveChatMembershipItemRenderer" })
                    {
                        if (!item.TryGetProperty(kind, out var message)) continue;
                        var id = message.TryGetProperty("id", out var rawId) ? rawId.GetString() ?? "" : "";
                        if (id.Length > 0)
                        {
                            if (!seen.Add(id)) continue;
                            order.Enqueue(id);
                            if (order.Count > 5000) seen.Remove(order.Dequeue());
                        }
                        var author = message.TryGetProperty("authorName", out var name) ? Text(name) : "YouTube user";
                        var text = message.TryGetProperty("message", out var body) ? Text(body)
                            : message.TryGetProperty("headerSubtext", out var header) ? Text(header) : "";
                        if (message.TryGetProperty("purchaseAmountText", out var amount)) text = Text(amount) + " " + text;
                        if (text.Trim().Length == 0 && message.TryGetProperty("sticker", out _)) text = "[スタンプ]";
                        cancellation.ThrowIfCancellationRequested();
                        publish(author, text);
                    }
                }
            }
            continuation = chat.TryGetProperty("continuations", out var continuations) ? Continuation(continuations) : "";
            var delay = Find(chat, "timeoutMs");
            var interval = delay is { ValueKind: JsonValueKind.Number } number && number.TryGetInt32(out var ms) ? Math.Clamp(ms, 2000, 30000) : 2000;
            await Task.Delay(interval, cancellation);
        }
    }

    private static string ExtractString(string page, string key, bool required = true)
    {
        var match = Regex.Match(page, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(\"(?:\\\\.|[^\"\\\\])*\")");
        if (match.Success) return JsonSerializer.Deserialize<string>(match.Groups[1].Value) ?? "";
        if (required) throw new InvalidOperationException("YouTubeコメントの接続情報が見つかりません");
        return "";
    }

    private static JsonDocument InitialData(string page)
    {
        var match = Regex.Match(page, "(?:var\\s+)?ytInitialData\\s*=\\s*|window\\[\"ytInitialData\"\\]\\s*=\\s*");
        if (!match.Success) throw new InvalidOperationException("YouTube配信ページを読み取れません");
        var reader = new Utf8JsonReader(Encoding.UTF8.GetBytes(page[(match.Index + match.Length)..]));
        return JsonDocument.ParseValue(ref reader);
    }

    private static string Continuation(JsonElement node) => Find(node, "continuation") is { ValueKind: JsonValueKind.String } value ? value.GetString() ?? "" : "";

    private static JsonElement? Find(JsonElement node, string key)
    {
        if (node.ValueKind == JsonValueKind.Object)
        {
            if (node.TryGetProperty(key, out var direct) && (key != "continuation" || direct.ValueKind == JsonValueKind.String)) return direct;
            foreach (var property in node.EnumerateObject()) { var found = Find(property.Value, key); if (found != null) return found; }
        }
        else if (node.ValueKind == JsonValueKind.Array)
            foreach (var item in node.EnumerateArray()) { var found = Find(item, key); if (found != null) return found; }
        return null;
    }

    private static string Text(JsonElement node)
    {
        if (node.TryGetProperty("simpleText", out var plain)) return plain.GetString() ?? "";
        if (!node.TryGetProperty("runs", out var runs)) return "";
        return string.Concat(runs.EnumerateArray().Select(run =>
        {
            if (run.TryGetProperty("text", out var text)) return text.GetString() ?? "";
            if (!run.TryGetProperty("emoji", out var emoji)) return "";
            if (emoji.TryGetProperty("shortcuts", out var shortcuts) && shortcuts.GetArrayLength() > 0) return shortcuts[0].GetString() ?? "";
            return emoji.TryGetProperty("emojiId", out var id) ? id.GetString() ?? "" : "";
        }));
    }
}
