using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace SyncLiveWeb;

internal sealed class OAuthService
{
    private sealed record Provider(string Name, string ClientId, string ClientSecret, string Access, string Refresh, string Expires, string Authorize, string Token, string Scopes);
    private sealed record Pending(string Provider, string Verifier, DateTimeOffset Created);
    private readonly Dictionary<string, Provider> providers = new()
    {
        ["twitch"] = new("twitch", "TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_ACCESS_TOKEN", "TWITCH_REFRESH_TOKEN", "TWITCH_TOKEN_EXPIRES_AT", "https://id.twitch.tv/oauth2/authorize", "https://id.twitch.tv/oauth2/token", "chat:read channel:manage:broadcast"),
        ["kick"] = new("kick", "KICK_CLIENT_ID", "KICK_CLIENT_SECRET", "KICK_ACCESS_TOKEN", "KICK_REFRESH_TOKEN", "KICK_TOKEN_EXPIRES_AT", "https://id.kick.com/oauth/authorize", "https://id.kick.com/oauth/token", "user:read channel:read channel:write events:subscribe"),
        ["youtube"] = new("youtube", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_ACCESS_TOKEN", "YOUTUBE_REFRESH_TOKEN", "YOUTUBE_TOKEN_EXPIRES_AT", "https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token", "https://www.googleapis.com/auth/youtube.force-ssl")
    };
    private readonly ConcurrentDictionary<string, Pending> pending = new();
    private readonly SemaphoreSlim refreshLock = new(1, 1);
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private readonly EnvFile env;
    private readonly int port;
    public OAuthService(EnvFile env, int port) { this.env = env; this.port = port; }
    private string Callback(string provider) => $"http://localhost:{port}/oauth/callback/{provider}";

    public object Status() => providers.ToDictionary(entry => entry.Key, entry => new
    {
        clientReady = env.Get(entry.Value.ClientId).Length > 0 && env.Get(entry.Value.ClientSecret).Length > 0,
        authorized = env.Get(entry.Value.Access).Length > 0,
        redirectUri = Callback(entry.Key)
    });

    public IResult SaveClient(string name, ClientSettings body)
    {
        if (!providers.TryGetValue(name, out var provider)) return Results.NotFound();
        if (string.IsNullOrWhiteSpace(body.ClientId) || string.IsNullOrWhiteSpace(body.ClientSecret) || body.ClientId.Length > 300 || body.ClientSecret.Length > 1000)
            return Results.BadRequest(new { ok = false, error = "クライアントIDとシークレットを入力してください" });
        env.Save(new Dictionary<string, string> { [provider.ClientId] = body.ClientId.Trim(), [provider.ClientSecret] = body.ClientSecret.Trim() });
        return Results.Ok(new { ok = true });
    }

    public IResult Start(string name, bool includeProfileDescription)
    {
        if (!providers.TryGetValue(name, out var provider)) return Results.NotFound();
        if (env.Get(provider.ClientId).Length == 0 || env.Get(provider.ClientSecret).Length == 0)
            return Results.Redirect($"/oauth-setup?provider={name}&result=client-missing");
        var state = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        var verifier = Convert.ToBase64String(RandomNumberGenerator.GetBytes(48)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        pending[state] = new(name, verifier, DateTimeOffset.UtcNow);
        foreach (var (key, value) in pending) if (DateTimeOffset.UtcNow - value.Created > TimeSpan.FromMinutes(10)) pending.TryRemove(key, out _);
        var scopes = name == "twitch" && includeProfileDescription ? provider.Scopes + " user:edit" : provider.Scopes;
        var query = new Dictionary<string, string>
        {
            ["client_id"] = env.Get(provider.ClientId), ["redirect_uri"] = Callback(name), ["response_type"] = "code",
            ["scope"] = scopes, ["state"] = state
        };
        if (name == "youtube") { query["access_type"] = "offline"; query["prompt"] = "consent"; }
        if (name == "kick")
        {
            var digest = SHA256.HashData(Encoding.UTF8.GetBytes(verifier));
            query["code_challenge"] = Convert.ToBase64String(digest).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            query["code_challenge_method"] = "S256";
        }
        return Results.Redirect(provider.Authorize + "?" + string.Join('&', query.Select(p => Uri.EscapeDataString(p.Key) + "=" + Uri.EscapeDataString(p.Value))));
    }

    public async Task<IResult> CallbackResult(string name, string? state, string? code, string? error)
    {
        if (!providers.TryGetValue(name, out var provider)) return Results.NotFound();
        IResult Finish(string result) => Results.Redirect($"/oauth-setup?provider={name}&result={result}");
        if (state == null || !pending.TryRemove(state, out var saved) || saved.Provider != name || DateTimeOffset.UtcNow - saved.Created > TimeSpan.FromMinutes(10)) return Finish("invalid-state");
        if (error != null) return Finish("denied");
        if (string.IsNullOrWhiteSpace(code)) return Finish("missing-code");
        try
        {
            var fields = new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code", ["code"] = code, ["client_id"] = env.Get(provider.ClientId),
                ["client_secret"] = env.Get(provider.ClientSecret), ["redirect_uri"] = Callback(name)
            };
            if (name == "kick") fields["code_verifier"] = saved.Verifier;
            await SaveToken(provider, await Exchange(provider, fields));
            if (name == "twitch") await IdentifyTwitch();
            if (name == "youtube")
            {
                var items = await Broadcasts();
                if (items.Count == 1) env.Save(new Dictionary<string, string> { ["YOUTUBE_BROADCAST_ID"] = items[0].Id });
            }
            return Finish("connected");
        }
        catch { return Finish("failed"); }
    }

    private async Task<JsonDocument> Exchange(Provider provider, Dictionary<string, string> fields)
    {
        using var response = await http.PostAsync(provider.Token, new FormUrlEncodedContent(fields));
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"{provider.Name} の認証に失敗しました (HTTP {(int)response.StatusCode})");
        var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (!document.RootElement.TryGetProperty("access_token", out _)) { document.Dispose(); throw new InvalidOperationException("アクセストークンを取得できませんでした"); }
        return document;
    }

    private Task SaveToken(Provider provider, JsonDocument token)
    {
        using (token)
        {
            var root = token.RootElement;
            var values = new Dictionary<string, string> { [provider.Access] = root.GetProperty("access_token").GetString() ?? "" };
            if (root.TryGetProperty("refresh_token", out var refresh)) values[provider.Refresh] = refresh.GetString() ?? "";
            if (root.TryGetProperty("expires_in", out var expires)) values[provider.Expires] = (DateTimeOffset.UtcNow.ToUnixTimeSeconds() + expires.GetInt64()).ToString();
            env.Save(values);
        }
        return Task.CompletedTask;
    }

    public async Task<string> FreshToken(string name)
    {
        var provider = providers[name];
        var current = env.Get(provider.Access);
        if (!long.TryParse(env.Get(provider.Expires), out var expiry) || expiry == 0 || DateTimeOffset.UtcNow.ToUnixTimeSeconds() < expiry - 90) return current;
        await refreshLock.WaitAsync();
        try
        {
            if (long.TryParse(env.Get(provider.Expires), out expiry) && DateTimeOffset.UtcNow.ToUnixTimeSeconds() < expiry - 90) return env.Get(provider.Access);
            if (env.Get(provider.Refresh).Length == 0) throw new InvalidOperationException($"{name} の再認証が必要です");
            var fields = new Dictionary<string, string>
            {
                ["grant_type"] = "refresh_token", ["client_id"] = env.Get(provider.ClientId),
                ["client_secret"] = env.Get(provider.ClientSecret), ["refresh_token"] = env.Get(provider.Refresh)
            };
            await SaveToken(provider, await Exchange(provider, fields));
            return env.Get(provider.Access);
        }
        finally { refreshLock.Release(); }
    }

    private async Task IdentifyTwitch()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.twitch.tv/helix/users");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", env.Get("TWITCH_ACCESS_TOKEN"));
        request.Headers.Add("Client-Id", env.Get("TWITCH_CLIENT_ID"));
        using var response = await http.SendAsync(request);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var user = document.RootElement.GetProperty("data")[0];
        env.Save(new Dictionary<string, string> { ["TWITCH_USERNAME"] = user.GetProperty("login").GetString() ?? "", ["TWITCH_CHANNEL"] = user.GetProperty("login").GetString() ?? "", ["TWITCH_BROADCASTER_ID"] = user.GetProperty("id").GetString() ?? "" });
    }

    public sealed record Broadcast(string Id, string Title, string Status);
    public async Task<List<Broadcast>> Broadcasts()
    {
        var token = await FreshToken("youtube");
        if (token.Length == 0) throw new InvalidOperationException("YouTube連携が必要です");
        var result = new List<Broadcast>();
        foreach (var status in new[] { "active", "upcoming" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"https://www.googleapis.com/youtube/v3/liveBroadcasts?part=id,snippet,status&broadcastStatus={status}&maxResults=50");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var response = await http.SendAsync(request);
            response.EnsureSuccessStatusCode();
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            foreach (var item in document.RootElement.GetProperty("items").EnumerateArray()) result.Add(new(item.GetProperty("id").GetString() ?? "", item.GetProperty("snippet").GetProperty("title").GetString() ?? "無題", status));
        }
        return result;
    }

    public async Task<IResult> SelectBroadcast(string id)
    {
        var items = await Broadcasts();
        if (!items.Any(item => item.Id == id)) return Results.NotFound(new { ok = false, error = "配信枠が見つかりません" });
        env.Save(new Dictionary<string, string> { ["YOUTUBE_BROADCAST_ID"] = id });
        return Results.Ok(new { ok = true });
    }
}

internal sealed record ClientSettings(string ClientId, string ClientSecret);
internal sealed record BroadcastSelection(string Id);
