using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace SyncLiveWeb;

internal sealed record YouTubeBroadcast(string Id, string StreamId);

internal sealed class YouTubeBroadcastService
{
    private readonly EnvFile env;
    private readonly OAuthService oauth;
    private readonly MetadataService metadata;
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(15) };
    public YouTubeBroadcastService(EnvFile env, OAuthService oauth, MetadataService metadata) { this.env = env; this.oauth = oauth; this.metadata = metadata; }

    public async Task<YouTubeBroadcast?> Prepare(string title, string rtmpUrl, bool createIfMissing)
    {
        if (env.Get("YOUTUBE_ACCESS_TOKEN").Length == 0 || rtmpUrl.Length == 0) return null;
        string? streamId = null;
        var pageToken = "";
        do
        {
            var query = "?part=id,cdn&mine=true&maxResults=50" + (pageToken.Length > 0 ? "&pageToken=" + Uri.EscapeDataString(pageToken) : "");
            var page = await Request(HttpMethod.Get, "liveStreams" + query);
            foreach (var item in page["items"]?.AsArray() ?? [])
            {
                var ingest = item?["cdn"]?["ingestionInfo"];
                if (ingest != null && $"{ingest["ingestionAddress"]}/{ingest["streamName"]}" == rtmpUrl.Trim()) { streamId = item?["id"]?.ToString(); break; }
            }
            pageToken = page["nextPageToken"]?.ToString() ?? "";
        } while (streamId == null && pageToken.Length > 0);
        if (streamId == null) throw new InvalidOperationException("YouTubeに保存済みの配信キーが見つかりません");

        JsonNode? broadcast = null;
        var selectedId = env.Get("YOUTUBE_BROADCAST_ID");
        if (selectedId.Length > 0)
        {
            var current = await Request(HttpMethod.Get, "liveBroadcasts?part=id,status,contentDetails,snippet&id=" + Uri.EscapeDataString(selectedId));
            var item = current["items"]?.AsArray().FirstOrDefault();
            var status = item?["status"]?["lifeCycleStatus"]?.ToString();
            if (item?["contentDetails"]?["boundStreamId"]?.ToString() == streamId && status is "ready" or "testing" or "live")
            {
                if (item?["status"]?["privacyStatus"]?.ToString() != "public") throw new InvalidOperationException("選択中のYouTube配信枠が公開設定ではありません");
                broadcast = item;
                if (item?["contentDetails"]?["latencyPreference"]?.ToString() != "ultraLow" && status != "ready")
                    throw new InvalidOperationException("配信中の枠は超低遅延に変更できません。配信枠を終了して再作成してください");
                if (item?["contentDetails"]?["latencyPreference"]?.ToString() != "ultraLow" && status == "ready")
                {
                    var details = YouTubeFields.Pick(item?["contentDetails"], "enableAutoStart", "enableAutoStop", "enableClosedCaptions", "enableDvr", "enableEmbed", "recordFromStart");
                    details["monitorStream"] = YouTubeFields.Pick(item?["contentDetails"]?["monitorStream"], "enableMonitorStream", "broadcastStreamDelayMs");
                    details["latencyPreference"] = "ultraLow";
                    broadcast = await Request(HttpMethod.Put, "liveBroadcasts?part=contentDetails", new JsonObject { ["id"] = selectedId, ["contentDetails"] = details });
                }
            }
        }
        if (broadcast == null)
        {
            if (!createIfMissing) return null;
            var descriptions = metadata.Descriptions();
            var snippet = new JsonObject { ["title"] = string.IsNullOrWhiteSpace(title) ? "SYNC LIVE" : title[..Math.Min(100, title.Length)], ["scheduledStartTime"] = DateTimeOffset.UtcNow.AddMinutes(1).ToString("O") };
            if (descriptions["youtube"].Length > 0) snippet["description"] = descriptions["youtube"];
            var body = new JsonObject
            {
                ["snippet"] = snippet,
                ["status"] = new JsonObject { ["privacyStatus"] = "public" },
                ["contentDetails"] = new JsonObject { ["latencyPreference"] = "ultraLow", ["enableAutoStart"] = true, ["enableAutoStop"] = true, ["monitorStream"] = new JsonObject { ["enableMonitorStream"] = false } }
            };
            var created = await Request(HttpMethod.Post, "liveBroadcasts?part=snippet,status,contentDetails", body);
            selectedId = created["id"]?.ToString() ?? throw new InvalidOperationException("YouTube配信枠を作成できませんでした");
            broadcast = await Request(HttpMethod.Post, "liveBroadcasts/bind?part=id,status,contentDetails,snippet&id=" + Uri.EscapeDataString(selectedId) + "&streamId=" + Uri.EscapeDataString(streamId));
        }
        selectedId = broadcast["id"]?.ToString() ?? selectedId;
        env.Save(new Dictionary<string, string> { ["YOUTUBE_BROADCAST_ID"] = selectedId });
        return new(selectedId, streamId);
    }

    public async Task Watch(YouTubeBroadcast broadcast, BridgeState state, Func<bool> stillRunning)
    {
        DateTimeOffset? started = null;
        var transitions = new HashSet<string>();
        var failures = 0;
        while (stillRunning())
        {
            if (state.Stream.Outputs.GetValueOrDefault("youtube")?.Status != "sending") { await Task.Delay(5000); continue; }
            started ??= DateTimeOffset.UtcNow;
            if (DateTimeOffset.UtcNow - started > TimeSpan.FromMinutes(5)) { if (stillRunning()) MarkFailed(state, "YouTubeの公開開始を5分以内に確認できませんでした"); return; }
            try
            {
                var status = await Advance(broadcast, transitions, stillRunning);
                failures = 0;
                if (status == "live") return;
            }
            catch (Exception ex)
            {
                if (!stillRunning()) return;
                if (++failures >= 24) { MarkFailed(state, "YouTube公開開始失敗: " + ex.Message); return; }
            }
            await Task.Delay(5000);
        }
    }

    private static void MarkFailed(BridgeState state, string detail)
    {
        var current = state.Stream;
        var outputs = new Dictionary<string, OutputHealth>(current.Outputs) { ["youtube"] = new("failed", detail) };
        state.SetStream(current with { Outputs = outputs });
    }

    private async Task<string> Advance(YouTubeBroadcast broadcast, HashSet<string> requested, Func<bool> stillRunning)
    {
        var stream = await Request(HttpMethod.Get, "liveStreams?part=status&id=" + Uri.EscapeDataString(broadcast.StreamId));
        if (stream["items"]?.AsArray().FirstOrDefault()?["status"]?["streamStatus"]?.ToString() != "active") return "waiting";
        var data = await Request(HttpMethod.Get, "liveBroadcasts?part=status,contentDetails&id=" + Uri.EscapeDataString(broadcast.Id));
        var item = data["items"]?.AsArray().FirstOrDefault();
        if (!stillRunning()) return "stopped";
        var status = item?["status"]?["lifeCycleStatus"]?.ToString();
        if (status == "live") return "live";
        if (status is "liveStarting" or "testStarting") return "waiting";
        if (status == "ready" && item?["contentDetails"]?["monitorStream"]?["enableMonitorStream"]?.ToString() == "true")
        {
            if (!requested.Contains("testing")) { await Request(HttpMethod.Post, "liveBroadcasts/transition?part=status&id=" + Uri.EscapeDataString(broadcast.Id) + "&broadcastStatus=testing"); requested.Add("testing"); }
            return "waiting";
        }
        if (status is "ready" or "testing")
        {
            if (!requested.Contains("live")) { await Request(HttpMethod.Post, "liveBroadcasts/transition?part=status&id=" + Uri.EscapeDataString(broadcast.Id) + "&broadcastStatus=live"); requested.Add("live"); }
            return "waiting";
        }
        throw new InvalidOperationException("YouTubeの配信枠を開始できません (" + status + ")");
    }

    private async Task<JsonNode> Request(HttpMethod method, string path, JsonNode? body = null)
    {
        using var request = new HttpRequestMessage(method, "https://www.googleapis.com/youtube/v3/" + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await oauth.FreshToken("youtube"));
        if (body != null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(request);
        var content = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"YouTube API HTTP {(int)response.StatusCode}");
        return JsonNode.Parse(content) ?? new JsonObject();
    }
}
