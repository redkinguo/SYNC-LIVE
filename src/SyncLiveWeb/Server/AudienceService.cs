using System.Net.Http.Headers;
using System.Text.Json;

namespace SyncLiveWeb;

internal sealed record AudienceMetric(bool Live, int? Viewers, DateTimeOffset? StartedAt, string Status, DateTimeOffset UpdatedAt);

internal sealed class AudienceService : IDisposable
{
    private readonly EnvFile env;
    private readonly OAuthService oauth;
    private readonly BridgeState state;
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private readonly CancellationTokenSource cancellation = new();
    private readonly Task loop;
    private string kickUserId = "";
    public AudienceService(EnvFile env, OAuthService oauth, BridgeState state)
    {
        this.env = env; this.oauth = oauth; this.state = state;
        loop = Loop();
    }

    private async Task Loop()
    {
        DateTimeOffset? previousStart = null;
        var nextPoll = DateTimeOffset.MinValue;
        while (!cancellation.IsCancellationRequested)
        {
            var stream = state.Stream;
            if (stream.StartedAt != previousStart) { previousStart = stream.StartedAt; nextPoll = DateTimeOffset.MinValue; }
            if (stream.Running && stream.Outputs.Values.Any(x => x.Status == "sending") && DateTimeOffset.UtcNow >= nextPoll)
            {
                var jobs = new[] { "twitch", "kick", "youtube" }.Select(async platform =>
                {
                    try { return (platform, metric: await Get(platform)); }
                    catch { return (platform, metric: new AudienceMetric(false, null, null, "error", DateTimeOffset.Now)); }
                });
                var result = await Task.WhenAll(jobs);
                if (!cancellation.IsCancellationRequested && state.Stream.StartedAt == stream.StartedAt)
                    state.SetAudience(result.ToDictionary(x => x.platform, x => (object)x.metric));
                nextPoll = DateTimeOffset.UtcNow.AddMinutes(1);
            }
            try { await Task.Delay(TimeSpan.FromSeconds(1), cancellation.Token); } catch (OperationCanceledException) { break; }
        }
    }

    private async Task<AudienceMetric> Get(string platform)
    {
        var now = DateTimeOffset.Now;
        if (platform == "twitch")
        {
            if (env.Get("TWITCH_CLIENT_ID").Length == 0 || env.Get("TWITCH_BROADCASTER_ID").Length == 0) return new(false, null, null, "unconfigured", now);
            using var data = await Read(platform, "https://api.twitch.tv/helix/streams?user_id=" + Uri.EscapeDataString(env.Get("TWITCH_BROADCASTER_ID")));
            return FromItem(data.RootElement.GetProperty("data"), "viewer_count", "started_at", now);
        }
        if (platform == "kick")
        {
            if (env.Get("KICK_ACCESS_TOKEN").Length == 0) return new(false, null, null, "unconfigured", now);
            if (kickUserId.Length == 0)
            {
                using var channels = await Read(platform, "https://api.kick.com/public/v1/channels");
                var items = channels.RootElement.GetProperty("data");
                if (items.GetArrayLength() > 0) kickUserId = items[0].GetProperty("broadcaster_user_id").ToString();
            }
            if (kickUserId.Length == 0) return new(false, null, null, "error", now);
            using var data = await Read(platform, "https://api.kick.com/public/v1/users/livestreams?user_id=" + Uri.EscapeDataString(kickUserId));
            return FromItem(data.RootElement.GetProperty("data"), "viewer_count", "started_at", now);
        }
        if (env.Get("YOUTUBE_ACCESS_TOKEN").Length == 0 || env.Get("YOUTUBE_BROADCAST_ID").Length == 0) return new(false, null, null, "unconfigured", now);
        using var youtube = await Read(platform, "https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=" + Uri.EscapeDataString(env.Get("YOUTUBE_BROADCAST_ID")));
        var videos = youtube.RootElement.GetProperty("items");
        if (videos.GetArrayLength() == 0 || !videos[0].TryGetProperty("liveStreamingDetails", out var details) || !details.TryGetProperty("actualStartTime", out var start) || details.TryGetProperty("actualEndTime", out _))
            return new(false, null, null, "offline", now);
        int? viewers = details.TryGetProperty("concurrentViewers", out var count) && int.TryParse(count.ToString(), out var number) ? number : null;
        return new(true, viewers, DateTimeOffset.TryParse(start.GetString(), out var date) ? date : null, "live", now);
    }

    private async Task<JsonDocument> Read(string platform, string url)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", (await oauth.FreshToken(platform)).Replace("oauth:", "", StringComparison.OrdinalIgnoreCase));
        if (platform == "twitch") request.Headers.Add("Client-Id", env.Get("TWITCH_CLIENT_ID"));
        using var response = await http.SendAsync(request, cancellation.Token);
        response.EnsureSuccessStatusCode();
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation.Token));
    }

    private static AudienceMetric FromItem(JsonElement items, string viewerField, string startedField, DateTimeOffset now)
    {
        if (items.GetArrayLength() == 0) return new(false, null, null, "offline", now);
        var item = items[0];
        int? viewers = item.TryGetProperty(viewerField, out var count) && int.TryParse(count.ToString(), out var number) ? number : null;
        DateTimeOffset? start = item.TryGetProperty(startedField, out var time) && DateTimeOffset.TryParse(time.GetString(), out var parsed) ? parsed : null;
        return new(true, viewers, start, "live", now);
    }

    public void Dispose()
    {
        cancellation.Cancel();
        _ = loop.ContinueWith(_ => { http.Dispose(); cancellation.Dispose(); }, TaskScheduler.Default);
    }
}
