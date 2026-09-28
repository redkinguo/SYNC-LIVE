using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SyncLiveWeb;

internal sealed class MetadataService
{
    private readonly EnvFile env;
    private readonly OAuthService oauth;
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private readonly string descriptionsPath = Path.Combine(AppContext.BaseDirectory, "data", "Web", "stream-descriptions.json");
    public MetadataService(EnvFile env, OAuthService oauth) { this.env = env; this.oauth = oauth; }

    public async Task<object> Get(string platform)
    {
        if (platform == "youtube")
        {
            var id = Required("YOUTUBE_BROADCAST_ID");
            var data = await Send("youtube", HttpMethod.Get, "https://www.googleapis.com/youtube/v3/videos?part=snippet&id=" + Uri.EscapeDataString(id));
            var item = First(data, "items") ?? throw new InvalidOperationException("YouTube配信動画が見つかりません");
            var snippet = item["snippet"]!;
            return new { title = String(snippet, "title"), description = String(snippet, "description"), categoryId = String(snippet, "categoryId"), tags = snippet["tags"]?.DeepClone() ?? new JsonArray() };
        }
        if (platform == "twitch")
        {
            var user = await TwitchUser();
            var id = env.Get("TWITCH_BROADCASTER_ID", String(user, "id"));
            var data = await Send("twitch", HttpMethod.Get, "https://api.twitch.tv/helix/channels?broadcaster_id=" + Uri.EscapeDataString(id));
            var channel = First(data, "data") ?? throw new InvalidOperationException("Twitchチャンネルが見つかりません");
            return new { title = String(channel, "title"), description = String(user, "description"), categoryId = String(channel, "game_id"), categoryName = String(channel, "game_name"), tags = channel["tags"]?.DeepClone() ?? new JsonArray() };
        }
        if (platform == "kick")
        {
            var data = await Send("kick", HttpMethod.Get, "https://api.kick.com/public/v1/channels");
            var channel = First(data, "data") ?? throw new InvalidOperationException("Kickチャンネルが見つかりません");
            return new { title = String(channel, "stream_title"), description = String(channel, "channel_description"), categoryId = String(channel["category"], "id"), categoryName = String(channel["category"], "name"), tags = channel["custom_tags"]?.DeepClone() ?? new JsonArray() };
        }
        throw new ArgumentException("配信先を確認してください");
    }

    public async Task<object> Categories(string platform, string query)
    {
        JsonNode data;
        JsonArray items;
        if (platform == "youtube")
        {
            data = await Send(platform, HttpMethod.Get, "https://www.googleapis.com/youtube/v3/videoCategories?part=snippet&regionCode=JP");
            items = data["items"]?.AsArray() ?? [];
            return items.Where(item => item?["snippet"]?["assignable"]?.GetValue<bool>() == true && String(item?["snippet"], "title").Contains(query, StringComparison.OrdinalIgnoreCase)).Select(item => new { id = String(item, "id"), name = String(item?["snippet"], "title") }).ToArray();
        }
        if (platform == "twitch")
        {
            if (string.IsNullOrWhiteSpace(query)) return Array.Empty<object>();
            data = await Send(platform, HttpMethod.Get, "https://api.twitch.tv/helix/search/categories?first=25&query=" + Uri.EscapeDataString(query));
            items = data["data"]?.AsArray() ?? [];
        }
        else if (platform == "kick")
        {
            if (query.Length < 3) return Array.Empty<object>();
            data = await Send(platform, HttpMethod.Get, "https://api.kick.com/public/v2/categories?limit=25&name=" + Uri.EscapeDataString(query));
            items = data["data"]?.AsArray() ?? [];
        }
        else throw new ArgumentException("配信先を確認してください");
        return items.Select(item => new { id = String(item, "id"), name = String(item, "name") }).ToArray();
    }

    public async Task<object> Update(string platform, MetadataInput input)
    {
        var tags = input.Tags?.Where(tag => !string.IsNullOrWhiteSpace(tag)).Select(tag => tag.Trim()).ToArray() ?? [];
        if (platform == "youtube")
        {
            var id = Required("YOUTUBE_BROADCAST_ID");
            var data = await Send(platform, HttpMethod.Get, "https://www.googleapis.com/youtube/v3/videos?part=snippet&id=" + Uri.EscapeDataString(id));
            var item = First(data, "items") ?? throw new InvalidOperationException("YouTube配信動画が見つかりません");
            var snippet = YouTubeFields.Pick(item["snippet"], "title", "description", "categoryId", "tags", "defaultLanguage", "defaultAudioLanguage");
            if (!string.IsNullOrWhiteSpace(input.Title)) snippet["title"] = input.Title.Trim();
            if (input.Description != null) snippet["description"] = input.Description;
            if (!string.IsNullOrWhiteSpace(input.CategoryId)) snippet["categoryId"] = input.CategoryId;
            if (input.Tags != null) snippet["tags"] = new JsonArray(tags.Select(tag => (JsonNode?)JsonValue.Create(tag)).ToArray());
            if (String(snippet, "title").Length > 100) throw new ArgumentException("YouTubeタイトルは100文字以内です");
            if (Encoding.UTF8.GetByteCount(String(snippet, "description")) > 5000) throw new ArgumentException("YouTube説明は5000バイト以内です");
            if (tags.Sum(tag => tag.Length) > 500) throw new ArgumentException("YouTubeタグの合計は500文字以内です");
            await Send(platform, HttpMethod.Put, "https://www.googleapis.com/youtube/v3/videos?part=snippet", new JsonObject { ["id"] = id, ["snippet"] = snippet });
            return new { ok = true, detail = "YouTubeの詳細情報を更新しました" };
        }
        if (platform == "twitch")
        {
            var user = await TwitchUser();
            var id = env.Get("TWITCH_BROADCASTER_ID", String(user, "id"));
            var body = new JsonObject();
            if (!string.IsNullOrWhiteSpace(input.Title)) { if (input.Title.Length > 140) throw new ArgumentException("Twitchタイトルは140文字以内です"); body["title"] = input.Title.Trim(); }
            if (!string.IsNullOrWhiteSpace(input.CategoryId)) body["game_id"] = input.CategoryId;
            if (input.Tags != null) { if (tags.Length > 10 || tags.Any(tag => tag.Length > 25 || tag.Any(c => !char.IsLetterOrDigit(c)))) throw new ArgumentException("Twitchタグは10個まで、各25文字以内の文字・数字で入力してください"); body["tags"] = new JsonArray(tags.Select(tag => (JsonNode?)JsonValue.Create(tag)).ToArray()); }
            if (body.Count == 0) throw new ArgumentException("変更したい項目を入力してください");
            await Send(platform, HttpMethod.Patch, "https://api.twitch.tv/helix/channels?broadcaster_id=" + Uri.EscapeDataString(id), body);
            return new { ok = true, detail = "Twitchの詳細情報を更新しました" };
        }
        if (platform == "kick")
        {
            var body = new JsonObject();
            if (!string.IsNullOrWhiteSpace(input.Title)) { if (input.Title.Length > 200) throw new ArgumentException("Kickタイトルは200文字以内です"); body["stream_title"] = input.Title.Trim(); }
            if (!string.IsNullOrWhiteSpace(input.CategoryId)) { if (!int.TryParse(input.CategoryId, out var id)) throw new ArgumentException("Kickカテゴリーを候補から選択してください"); body["category_id"] = id; }
            if (input.Tags != null) { if (tags.Length > 10 || tags.Any(tag => tag.Length > 100)) throw new ArgumentException("Kickのカスタムタグは最大10個です"); body["custom_tags"] = new JsonArray(tags.Select(tag => (JsonNode?)JsonValue.Create(tag)).ToArray()); }
            if (body.Count == 0) throw new ArgumentException("変更したい項目を入力してください");
            await Send(platform, HttpMethod.Patch, "https://api.kick.com/public/v1/channels", body);
            return new { ok = true, detail = "Kickの詳細情報を更新しました" };
        }
        throw new ArgumentException("配信先を確認してください");
    }

    public async Task<object> Thumbnail(HttpRequest request)
    {
        var id = Required("YOUTUBE_BROADCAST_ID");
        var mime = request.ContentType?.Split(';')[0].Trim().ToLowerInvariant();
        if (mime is not ("image/jpeg" or "image/png")) throw new ArgumentException("JPGまたはPNGを選択してください");
        using var memory = new MemoryStream();
        await request.Body.CopyToAsync(memory);
        if (memory.Length > 2 * 1024 * 1024) throw new ArgumentException("画像は2MB以下にしてください");
        var image = memory.ToArray();
        var jpeg = mime == "image/jpeg" && image.Length > 3 && image[0] == 0xff && image[1] == 0xd8 && image[2] == 0xff;
        var png = mime == "image/png" && image.Length > 8 && image[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        if (!jpeg && !png) throw new ArgumentException("画像ファイルを読み取れません");
        var token = await oauth.FreshToken("youtube");
        using var upload = new HttpRequestMessage(HttpMethod.Post, "https://www.googleapis.com/upload/youtube/v3/thumbnails/set?uploadType=media&videoId=" + Uri.EscapeDataString(id));
        upload.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        upload.Content = new ByteArrayContent(image); upload.Content.Headers.ContentType = new(mime);
        using var response = await http.SendAsync(upload);
        response.EnsureSuccessStatusCode();
        return new { ok = true, detail = "YouTubeのサムネイルを更新しました" };
    }

    public Dictionary<string, string> Descriptions()
    {
        var empty = new Dictionary<string, string> { ["youtube"] = "", ["twitch"] = "", ["kick"] = "" };
        if (!File.Exists(descriptionsPath)) return empty;
        try { var saved = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(descriptionsPath)); foreach (var key in empty.Keys.ToArray()) empty[key] = saved?.GetValueOrDefault(key) ?? ""; } catch { }
        return empty;
    }

    public Dictionary<string, string> SaveDescriptions(Dictionary<string, string> input)
    {
        var values = Descriptions();
        foreach (var key in values.Keys.ToArray()) values[key] = input.GetValueOrDefault(key) ?? "";
        if (Encoding.UTF8.GetByteCount(values["youtube"]) > 5000 || values["twitch"].Length > 300 || values["kick"].Length > 5000) throw new ArgumentException("固定説明が長すぎます");
        Directory.CreateDirectory(Path.GetDirectoryName(descriptionsPath)!);
        File.WriteAllText(descriptionsPath, JsonSerializer.Serialize(values, new JsonSerializerOptions { WriteIndented = true }));
        return values;
    }

    public async Task<object> PinYouTubeDescription()
    {
        var item = await Send("youtube", HttpMethod.Get, "https://www.googleapis.com/youtube/v3/videos?part=snippet&id=" + Uri.EscapeDataString(Required("YOUTUBE_BROADCAST_ID")));
        var video = First(item, "items") ?? throw new InvalidOperationException("配信枠が見つかりません");
        var values = Descriptions(); values["youtube"] = String(video["snippet"], "description"); SaveDescriptions(values);
        return new { ok = true, detail = "現在のYouTube説明を次回配信向けに保存しました" };
    }

    public async Task<object> UpdateTwitchDescription(string description)
    {
        if (description.Length > 300) throw new ArgumentException("Twitchの説明は300文字以内です");
        await Send("twitch", HttpMethod.Put, "https://api.twitch.tv/helix/users?description=" + Uri.EscapeDataString(description));
        var values = Descriptions(); values["twitch"] = description; SaveDescriptions(values);
        return new { ok = true, detail = "Twitchチャンネル説明を更新しました" };
    }

    private async Task<JsonNode> TwitchUser()
    {
        var data = await Send("twitch", HttpMethod.Get, "https://api.twitch.tv/helix/users");
        return First(data, "data") ?? throw new InvalidOperationException("Twitchアカウントを取得できません");
    }

    private async Task<JsonNode> Send(string platform, HttpMethod method, string url, JsonNode? body = null)
    {
        var token = await oauth.FreshToken(platform);
        if (token.Length == 0) throw new InvalidOperationException($"{platform} のOAuth連携が必要です");
        using var request = new HttpRequestMessage(method, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Replace("oauth:", "", StringComparison.OrdinalIgnoreCase));
        if (platform == "twitch") request.Headers.Add("Client-Id", Required("TWITCH_CLIENT_ID"));
        if (body != null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(request);
        var content = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"{platform} API HTTP {(int)response.StatusCode}");
        return string.IsNullOrWhiteSpace(content) ? new JsonObject() : JsonNode.Parse(content) ?? new JsonObject();
    }

    private string Required(string key) => env.Get(key).Length > 0 ? env.Get(key) : throw new InvalidOperationException($"{key} が未設定です");
    private static JsonNode? First(JsonNode node, string key) => node[key]?.AsArray().FirstOrDefault();
    private static string String(JsonNode? node, string key) => node?[key]?.ToString() ?? "";
}

internal sealed record MetadataInput(string? Title, string? Description, string? CategoryId, string[]? Tags);
internal sealed record DescriptionInput(string Description);
