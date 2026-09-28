using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SyncLiveWeb;

internal sealed record TitleResult(string Platform, bool Ok, string Detail, bool Skipped = false);

internal sealed class TitleService
{
    private readonly EnvFile env;
    private readonly OAuthService oauth;
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(15) };
    public TitleService(EnvFile env, OAuthService oauth) { this.env = env; this.oauth = oauth; }

    public async Task<TitleResult[]> Sync(string title)
    {
        var results = new List<TitleResult>();
        foreach (var platform in new[] { "twitch", "kick", "youtube" })
        {
            try
            {
                if (platform == "twitch") await Twitch(title);
                else if (platform == "kick") await Kick(title);
                else await YouTube(title);
                results.Add(new(platform, true, "タイトル更新済み"));
            }
            catch (InvalidOperationException ex) when (ex.Message == "認証情報未設定") { results.Add(new(platform, false, ex.Message, true)); }
            catch (Exception ex) { results.Add(new(platform, false, ex.Message)); }
        }
        return results.ToArray();
    }

    private async Task Twitch(string title)
    {
        var token = (await oauth.FreshToken("twitch")).Replace("oauth:", "", StringComparison.OrdinalIgnoreCase).Trim();
        var clientId = env.Get("TWITCH_CLIENT_ID");
        var broadcaster = env.Get("TWITCH_BROADCASTER_ID");
        if (token.Length == 0 || clientId.Length == 0 || broadcaster.Length == 0) throw new InvalidOperationException("認証情報未設定");
        using var request = new HttpRequestMessage(HttpMethod.Patch, "https://api.twitch.tv/helix/channels?broadcaster_id=" + Uri.EscapeDataString(broadcaster));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add("Client-Id", clientId);
        request.Content = JsonContent(new { title });
        using var response = await http.SendAsync(request);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"Twitch API HTTP {(int)response.StatusCode}");
    }

    private async Task Kick(string title)
    {
        var token = (await oauth.FreshToken("kick")).Trim();
        if (token.Length == 0) throw new InvalidOperationException("認証情報未設定");
        using var request = new HttpRequestMessage(HttpMethod.Patch, "https://api.kick.com/public/v1/channels");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Content = JsonContent(new { stream_title = title });
        using var response = await http.SendAsync(request);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"Kick API HTTP {(int)response.StatusCode}");
    }

    private async Task YouTube(string title)
    {
        var token = (await oauth.FreshToken("youtube")).Trim();
        var id = env.Get("YOUTUBE_BROADCAST_ID").Trim();
        if (token.Length == 0 || id.Length == 0) throw new InvalidOperationException("認証情報未設定");
        using var get = new HttpRequestMessage(HttpMethod.Get, "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,contentDetails&id=" + Uri.EscapeDataString(id));
        get.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await http.SendAsync(get);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"YouTube API HTTP {(int)response.StatusCode}");
        var payload = JsonNode.Parse(await response.Content.ReadAsStringAsync());
        var broadcast = payload?["items"]?.AsArray().FirstOrDefault();
        if (broadcast == null) throw new InvalidOperationException("YouTube配信枠が見つかりません");
        var snippet = YouTubeFields.Pick(broadcast["snippet"], "title", "description", "scheduledStartTime", "scheduledEndTime");
        snippet["title"] = title;
        var update = new JsonObject { ["id"] = id, ["snippet"] = snippet };
        using var put = new HttpRequestMessage(HttpMethod.Put, "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet");
        put.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        put.Content = new StringContent(update.ToJsonString(), Encoding.UTF8, "application/json");
        using var result = await http.SendAsync(put);
        if (!result.IsSuccessStatusCode) throw new InvalidOperationException($"YouTube API HTTP {(int)result.StatusCode}");
    }

    private static StringContent JsonContent(object value) => new(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json");
}
