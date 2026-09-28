using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;

namespace SyncLiveWeb;

internal sealed record ChatMessage(string Id, string Platform, string User, string Text, string Time, bool Bot = false);
internal sealed record OutputHealth(string Status, string Detail);
internal sealed record StreamState(bool Running, string Detail, int Destinations, Dictionary<string, OutputHealth> Outputs, DateTimeOffset? StartedAt);

internal sealed class BridgeState
{
    private readonly EnvFile env;
    private readonly object gate = new();
    private readonly ConcurrentDictionary<Guid, Channel<string>> clients = new();
    private readonly Dictionary<string, bool> connected = new() { ["twitch"] = false, ["kick"] = false, ["youtube"] = false };
    private readonly List<ChatMessage> messages = [];
    private StreamState stream = new(false, "停止中", 0, [], null);
    private Dictionary<string, object> audience = [];
    public bool LiveMode => env.Get("LIVEBRIDGE_MODE", "demo").Equals("live", StringComparison.OrdinalIgnoreCase);

    public BridgeState(EnvFile env)
    {
        this.env = env;
        if (!LiveMode)
        {
            messages.Add(new("demo-1", "twitch", "kuro_neko", "こんばんは！今日も楽しみにしてました", "12:41:08"));
            messages.Add(new("demo-2", "youtube", "sora_live", "音声ばっちり聞こえてます 🙌", "12:41:06"));
            messages.Add(new("demo-3", "kick", "bigwave77", "First time here, what game is this?", "12:41:03"));
        }
    }

    public object Snapshot()
    {
        lock (gate)
        {
            return new
            {
                mode = LiveMode ? "live" : "demo",
                connected = new Dictionary<string, bool>(connected),
                messages = messages.ToArray(),
                stream,
                audience = new Dictionary<string, object>(audience),
                readiness = new
                {
                    twitch = new { chat = Has("TWITCH_USERNAME", "TWITCH_ACCESS_TOKEN", "TWITCH_CHANNEL"), title = Has("TWITCH_ACCESS_TOKEN", "TWITCH_CLIENT_ID", "TWITCH_BROADCASTER_ID"), stream = Has("RTMP_TWITCH") },
                    kick = new { chat = Has("KICK_WEBHOOK_PUBLIC_URL", "KICK_ACCESS_TOKEN"), title = Has("KICK_ACCESS_TOKEN"), stream = Has("RTMP_KICK") },
                    youtube = new { chat = Has("YOUTUBE_BROADCAST_ID") || Has("YOUTUBE_CHANNEL_ID"), title = Has("YOUTUBE_ACCESS_TOKEN", "YOUTUBE_BROADCAST_ID"), stream = Has("RTMP_YOUTUBE") }
                },
                obsIngestUrl = env.Get("OBS_INGEST_URL", "rtmp://127.0.0.1:1935/live/stream")
            };
        }
    }

    private bool Has(params string[] keys) => keys.All(key => !string.IsNullOrWhiteSpace(env.Get(key)));

    public bool Connected(string platform) { lock (gate) return connected.GetValueOrDefault(platform); }

    public void SetConnected(string platform, bool value, string detail = "")
    {
        lock (gate) connected[platform] = value;
        Emit("connection", new { platform, connected = value, detail });
    }

    public void Publish(string platform, string user, string text, bool bot = false)
    {
        if (string.IsNullOrWhiteSpace(text) || string.IsNullOrWhiteSpace(user)) return;
        if (platform is not ("twitch" or "kick" or "youtube")) return;
        var item = new ChatMessage($"{platform}-{Guid.NewGuid():N}", platform, user[..Math.Min(120, user.Length)], text[..Math.Min(2000, text.Length)], DateTime.Now.ToString("HH:mm:ss"), bot);
        lock (gate)
        {
            if (messages.Any(m => m.Platform == platform && m.User == item.User && m.Text == item.Text && m.Time == item.Time)) return;
            messages.Insert(0, item);
            if (messages.Count > 500) messages.RemoveRange(500, messages.Count - 500);
        }
        Emit("message", item);
    }

    public StreamState Stream { get { lock (gate) return stream; } }

    public void SetStream(StreamState value)
    {
        lock (gate)
        {
            stream = value;
            if (!value.Running) audience = [];
        }
        Emit("stream", value);
        if (!value.Running) Emit("audience", new Dictionary<string, object>());
    }

    public void SetAudience(Dictionary<string, object> value)
    {
        lock (gate)
        {
            if (!stream.Running) return;
            audience = value;
        }
        Emit("audience", value);
    }

    public ChannelReader<string> Subscribe(out Guid id)
    {
        id = Guid.NewGuid();
        var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(512) { FullMode = BoundedChannelFullMode.DropOldest });
        clients[id] = channel;
        channel.Writer.TryWrite(Packet("state", Snapshot()));
        return channel.Reader;
    }

    public void Unsubscribe(Guid id)
    {
        if (clients.TryRemove(id, out var channel)) channel.Writer.TryComplete();
    }

    private void Emit(string type, object data)
    {
        var packet = Packet(type, data);
        foreach (var channel in clients.Values) channel.Writer.TryWrite(packet);
    }

    private static string Packet(string type, object data) =>
        "data: " + JsonSerializer.Serialize(new { type, data }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }) + "\n\n";
}
