using System.Diagnostics;
using System.Text.Json;
using SyncLiveWeb;

var root = AppContext.BaseDirectory;
var settingsDirectory = Path.Combine(root, "data", "Web");
Directory.CreateDirectory(settingsDirectory);
var env = new EnvFile(Path.Combine(settingsDirectory, ".env"));
var host = env.Get("LIVEBRIDGE_HOST", "127.0.0.1");
var port = int.TryParse(env.Get("LIVEBRIDGE_PORT", "4317"), out var configuredPort) ? configuredPort : 4317;
var kickPort = int.TryParse(env.Get("KICK_WEBHOOK_PORT", "4320"), out var configuredKickPort) ? configuredKickPort : 4320;
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = root,
    WebRootPath = Path.Combine(root, "assets", "web")
});
builder.WebHost.UseUrls($"http://{host}:{port}", $"http://127.0.0.1:{kickPort}");
var app = builder.Build();
var state = new BridgeState(env);
var oauth = new OAuthService(env, port);
var metadata = new MetadataService(env, oauth);
var titles = new TitleService(env, oauth);
var youtube = new YouTubeBroadcastService(env, oauth, metadata);
var relay = new StreamRelay(env, state, youtube, titles);
var connections = new ChatConnections(env, state, oauth);
var audience = new AudienceService(env, oauth, state);

app.Use(async (context, next) =>
{
    if (context.Connection.LocalPort == kickPort &&
        !(HttpMethods.IsPost(context.Request.Method) && context.Request.Path == "/webhooks/kick"))
    {
        context.Response.StatusCode = 404;
        return;
    }
    try { await next(); }
    catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
    catch (Exception ex) when (!context.Response.HasStarted)
    {
        context.Response.StatusCode = ex is ArgumentException or InvalidOperationException or JsonException ? 400 : 502;
        await context.Response.WriteAsJsonAsync(new { ok = false, error = ex.Message });
    }
});

app.UseDefaultFiles();
app.UseStaticFiles();
app.MapGet("/health", () => Results.Json(new { ok = true, mode = state.LiveMode ? "live" : "demo" }));
app.MapGet("/api/state", () => Results.Json(state.Snapshot()));
app.MapGet("/api/events", async (HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-cache";
    context.Response.Headers.Connection = "keep-alive";
    context.Response.ContentType = "text/event-stream";
    var reader = state.Subscribe(out var id);
    try
    {
        while (!context.RequestAborted.IsCancellationRequested)
        {
            using var wait = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
            wait.CancelAfter(TimeSpan.FromSeconds(20));
            try { await context.Response.WriteAsync(await reader.ReadAsync(wait.Token), context.RequestAborted); }
            catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
            { await context.Response.WriteAsync(": keep-alive\n\n", context.RequestAborted); }
            await context.Response.Body.FlushAsync(context.RequestAborted);
        }
    }
    catch (OperationCanceledException) { }
    finally { state.Unsubscribe(id); }
});
app.MapPost("/api/demo/comment", (CommentRequest body) =>
{
    if (state.LiveMode) return Results.Json(new { ok = false, error = "デモモードのみ使えます" }, statusCode: 403);
    if (!ValidPlatform(body.Platform)) return Results.BadRequest(new { ok = false, error = "配信先を確認してください" });
    state.Publish(body.Platform, string.IsNullOrWhiteSpace(body.User) ? "demo_viewer" : body.User, string.IsNullOrWhiteSpace(body.Text) ? "テストコメント" : body.Text);
    return Results.Ok(new { ok = true });
});
app.MapPost("/api/manual/comment", (CommentRequest body) =>
{
    if (!state.LiveMode) return Results.Json(new { ok = false, error = "ライブ接続モードで使用してください" }, statusCode: 403);
    if (!ValidPlatform(body.Platform) || string.IsNullOrWhiteSpace(body.Text)) return Results.BadRequest(new { ok = false, error = "表示先とコメントを入力してください" });
    state.Publish(body.Platform, "手動入力", body.Text.Trim());
    return Results.Ok(new { ok = true });
});
app.MapPost("/api/connect/{platform}", async (string platform, ConnectRequest? body) =>
{
    if (!ValidPlatform(platform)) return Results.BadRequest(new { ok = false, error = "配信先を確認してください" });
    if (!state.LiveMode) { state.SetConnected(platform, true, "デモ接続中"); return Results.Ok(new { ok = true, connected = true, detail = "デモ接続中" }); }
    try
    {
        var detail = await connections.Connect(platform, body?.Handle ?? "");
        return Results.Ok(new { ok = true, connected = true, detail });
    }
    catch (Exception ex) { state.SetConnected(platform, false, ex.Message); return Results.BadRequest(new { ok = false, error = ex.Message }); }
});
app.MapPost("/api/disconnect/{platform}", (string platform) =>
{
    if (!ValidPlatform(platform)) return Results.BadRequest(new { ok = false, error = "配信先を確認してください" });
    connections.Disconnect(platform);
    state.SetConnected(platform, false);
    return Results.Ok(new { ok = true, connected = false });
});
app.MapPost("/api/stream/start", async (StartRequest? body) =>
{
    var result = await relay.StartWithObs(body?.Title ?? "", body?.Platforms);
    if (state.Stream.Running && (env.Get("YOUTUBE_BROADCAST_ID").Length > 0 || env.Get("YOUTUBE_CHANNEL_ID").Length > 0))
        _ = connections.Connect("youtube", "").ContinueWith(task => { if (task.IsFaulted) state.SetConnected("youtube", false, task.Exception?.GetBaseException().Message ?? "接続失敗"); });
    return Results.Json(result);
});
app.MapPost("/api/stream/prepare", async (StartRequest? body) => Results.Json(await relay.StartWithObs(body?.Title ?? "", ["twitch", "kick", "youtube"], true, false)));
app.MapPost("/api/stream/stop", async () =>
{
    var result = await relay.StopWithObs();
    connections.Disconnect("youtube");
    state.SetConnected("youtube", false, "切断");
    return Results.Json(result);
});
app.MapPost("/api/titles/sync", async (TitleRequest body) =>
{
    if (!state.LiveMode) return Results.Json(new { ok = false, error = "ライブモードで使用してください" }, statusCode: 403);
    if (string.IsNullOrWhiteSpace(body.Title)) return Results.BadRequest(new { ok = false, error = "共通配信タイトルを入力してください" });
    var results = await titles.Sync(body.Title.Trim()[..Math.Min(100, body.Title.Trim().Length)]);
    return Results.Ok(new { ok = results.All(x => x.Ok), results });
});
app.MapPost("/webhooks/kick", async (HttpRequest request) => await connections.KickWebhook(request));
app.MapGet("/api/oauth/status", () => Results.Json(oauth.Status()));
app.MapPost("/api/oauth/client/{platform}", (HttpContext context, string platform, ClientSettings body) =>
    Local(context) ? oauth.SaveClient(platform, body) : Results.Json(new { ok = false, error = "このPC上からのみ設定できます" }, statusCode: 403));
app.MapGet("/oauth/start/{platform}", (string platform, string? include) => oauth.Start(platform, include == "profile-description"));
app.MapGet("/oauth/callback/{platform}", async (string platform, string? state, string? code, string? error) => await oauth.CallbackResult(platform, state, code, error));
app.MapGet("/api/oauth/youtube/broadcasts", async () => Results.Ok(new { ok = true, broadcasts = await oauth.Broadcasts() }));
app.MapPost("/api/oauth/youtube/broadcast", async (HttpContext context, BroadcastSelection body) =>
    Local(context) ? await oauth.SelectBroadcast(body.Id) : Results.Json(new { ok = false, error = "このPC上からのみ設定できます" }, statusCode: 403));
app.MapGet("/api/metadata/descriptions", (HttpContext context) =>
    Local(context) ? Results.Ok(new { ok = true, descriptions = metadata.Descriptions() }) : Results.Json(new { ok = false, error = "Local access required" }, statusCode: 403));
app.MapPost("/api/metadata/descriptions", (HttpContext context, Dictionary<string, string> body) =>
    Local(context) ? Results.Ok(new { ok = true, descriptions = metadata.SaveDescriptions(body), detail = "固定説明をこのPCに保存しました" }) : Results.Json(new { ok = false, error = "Local access required" }, statusCode: 403));
app.MapGet("/api/metadata/categories/{platform}", async (HttpContext context, string platform, string? q) =>
    Local(context) ? await MetadataResult(async () => new { ok = true, categories = await metadata.Categories(platform, q ?? "") }) : Results.Json(new { ok = false, error = "Local access required" }, statusCode: 403));
app.MapGet("/api/metadata/{platform}", async (HttpContext context, string platform) =>
    Local(context) ? await MetadataResult(async () => new { ok = true, metadata = await metadata.Get(platform) }) : Results.Json(new { ok = false, error = "Local access required" }, statusCode: 403));
app.MapPost("/api/metadata/{platform}", async (HttpContext context, string platform, MetadataInput body) =>
    Local(context) ? await MetadataResult(() => metadata.Update(platform, body)) : Results.Json(new { ok = false, error = "Local access required" }, statusCode: 403));
app.MapPost("/api/metadata/youtube/thumbnail", async (HttpContext context) =>
    Local(context) ? await MetadataResult(() => metadata.Thumbnail(context.Request)) : Results.Json(new { ok = false, error = "Local access required" }, statusCode: 403));
app.MapPost("/api/metadata/youtube/fix-current-description", async (HttpContext context) =>
    Local(context) ? await MetadataResult(() => metadata.PinYouTubeDescription()) : Results.Json(new { ok = false, error = "Local access required" }, statusCode: 403));
app.MapPost("/api/metadata/twitch/description", async (HttpContext context, DescriptionInput body) =>
    Local(context) ? await MetadataResult(() => metadata.UpdateTwitchDescription(body.Description)) : Results.Json(new { ok = false, error = "Local access required" }, statusCode: 403));
app.MapFallbackToFile("index.html");

if (state.LiveMode)
{
    _ = Task.Run(async () =>
    {
        foreach (var platform in new[] { "twitch", "kick", "youtube" })
            try { await connections.Connect(platform, ""); } catch (Exception ex) { state.SetConnected(platform, false, ex.Message); }
        await Task.Delay(300);
        await relay.StartWithObs("", ["twitch", "kick", "youtube"], true, false);
        if (state.Stream.Running && (env.Get("YOUTUBE_BROADCAST_ID").Length > 0 || env.Get("YOUTUBE_CHANNEL_ID").Length > 0))
            try { await connections.Connect("youtube", ""); } catch (Exception ex) { state.SetConnected("youtube", false, ex.Message); }
    });
}

app.Lifetime.ApplicationStarted.Register(() =>
{
    Console.WriteLine($"SYNC LIVE: http://{host}:{port}");
    if (!args.Contains("--no-browser"))
        try { Process.Start(new ProcessStartInfo($"http://{host}:{port}") { UseShellExecute = true }); } catch { }
});
app.Lifetime.ApplicationStopping.Register(() => { relay.Stop(); connections.Dispose(); audience.Dispose(); });
app.Run();

static bool ValidPlatform(string? value) => value is "twitch" or "kick" or "youtube";
static bool Local(HttpContext context) => System.Net.IPAddress.IsLoopback(context.Connection.RemoteIpAddress ?? System.Net.IPAddress.None);
static async Task<IResult> MetadataResult(Func<Task<object>> action)
{
    try { return Results.Ok(await action()); }
    catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or HttpRequestException or JsonException)
    { return Results.BadRequest(new { ok = false, error = ex.Message }); }
}

internal sealed record CommentRequest(string Platform, string? User, string Text);
internal sealed record ConnectRequest(string? Handle);
internal sealed record StartRequest(string? Title, string[]? Platforms);
internal sealed record TitleRequest(string Title);
