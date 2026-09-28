using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace SyncLiveWeb;

internal sealed class StreamRelay
{
    private readonly EnvFile env;
    private readonly BridgeState state;
    private readonly YouTubeBroadcastService youtube;
    private readonly TitleService titles;
    private readonly object gate = new();
    private readonly SemaphoreSlim operations = new(1, 1);
    private long generation;
    private Process? process;
    private bool autoArm;

    public StreamRelay(EnvFile env, BridgeState state, YouTubeBroadcastService youtube, TitleService titles)
    { this.env = env; this.state = state; this.youtube = youtube; this.titles = titles; }

    public async Task<object> StartWithObs(string title, IReadOnlyList<string>? selected = null, bool automatic = false, bool startObs = true)
    {
        await operations.WaitAsync();
        try { return await StartCore(title, selected, automatic, startObs); }
        finally { operations.Release(); }
    }

    private async Task<object> StartCore(string title, IReadOnlyList<string>? selected, bool automatic, bool startObs)
    {
        long session;
        lock (gate)
        {
            if (!state.LiveMode) return new { ok = false, error = "配信リレーは LIVE モードで設定してください" };
            if (process != null) return new { ok = true, running = true, detail = state.Stream.Detail };
            session = ++generation;
        }
        var validation = ValidateTargets(selected);
        if (validation.error != null) return new { ok = false, error = validation.error };
        YouTubeBroadcast? broadcast = null;
        var youtubeTarget = env.Get("RTMP_YOUTUBE").Trim();
        if (state.LiveMode && youtubeTarget.Length > 0 && (selected == null || selected.Contains("youtube")))
        {
            try
            {
                broadcast = await youtube.Prepare(title, youtubeTarget, !automatic);
                if (broadcast == null && !automatic) return new { ok = false, error = "YouTube OAuth連携が必要です" };
            }
            catch (Exception ex)
            {
                if (!automatic) return new { ok = false, error = "YouTube配信枠の準備に失敗しました: " + ex.Message };
            }
        }
        object result;
        lock (gate)
        {
            if (generation != session) return new { ok = false, error = "開始をキャンセルしました" };
            result = Start(title, selected, automatic);
        }
        bool Current() { lock (gate) return generation == session && process != null && state.Stream.Running; }
        if (!Current()) return result;
        if (broadcast != null) _ = youtube.Watch(broadcast, state, Current);
        TitleResult[] titleResults = [];
        if (!string.IsNullOrWhiteSpace(title)) titleResults = await titles.Sync(title.Trim()[..Math.Min(100, title.Trim().Length)]);
        if (!startObs) return new { ok = true, running = true, detail = state.Stream.Detail, titles = titleResults, obsStarted = false };
        var address = env.Get("OBS_WS_URL");
        var password = env.Get("OBS_WS_PASSWORD");
        if (address.Length == 0 || password.Length == 0) return new { ok = true, running = true, detail = state.Stream.Detail, titles = titleResults, obsStarted = false };
        try
        {
            await Task.Delay(1000);
            if (!Current()) return new { ok = false, error = "開始をキャンセルしました" };
            await ObsControl.Request(address, password, "StartStream");
            lock (gate) if (Current()) state.SetStream(state.Stream with { Detail = "OBS も配信開始しました" });
            return new { ok = true, running = true, detail = "OBS も配信開始しました", titles = titleResults, obsStarted = true };
        }
        catch (Exception ex)
        {
            lock (gate) if (Current()) state.SetStream(state.Stream with { Detail = "OBS 自動開始失敗: " + ex.Message });
            return new { ok = true, running = true, detail = state.Stream.Detail, titles = titleResults, obsStarted = false };
        }
    }

    public async Task<object> StopWithObs()
    {
        await operations.WaitAsync();
        try
        {
            if (!state.LiveMode) return new { ok = true, running = false, detail = "停止中" };
            var address = env.Get("OBS_WS_URL");
            var password = env.Get("OBS_WS_PASSWORD");
            string detail = "";
            if (address.Length > 0 && password.Length > 0)
                try { await ObsControl.Request(address, password, "StopStream"); detail = "OBS 停止済み · "; }
                catch (Exception ex) { detail = "OBS 停止失敗: " + ex.Message + " · "; }
            Stop();
            return new { ok = true, running = false, detail = detail + "配信リレー停止処理中" };
        }
        finally { operations.Release(); }
    }

    private (List<(string platform, string url)> targets, string? error) ValidateTargets(IReadOnlyList<string>? selected)
    {
        var platforms = new[] { "twitch", "kick", "youtube" };
        var targets = platforms.Where(p => selected == null || selected.Contains(p)).Select(p => (platform: p, url: env.Get("RTMP_" + p.ToUpperInvariant()).Trim())).ToList();
        if (selected != null && targets.Count == 0) return (targets, "配信先を選んでください");
        var missing = targets.Where(t => t.url.Length == 0).Select(t => t.platform).ToArray();
        if (missing.Length > 0 && (selected != null || env.IsTrue("LIVEBRIDGE_REQUIRE_ALL_DESTINATIONS")))
            return (targets, "配信先 RTMP URL が未設定です: " + string.Join(", ", missing));
        targets.RemoveAll(t => t.url.Length == 0);
        if (targets.Count == 0) return (targets, "YouTube・Twitch・KickのRTMP設定を確認してください");
        if (targets.Any(t => !Regex.IsMatch(t.url, "^rtmps?://", RegexOptions.IgnoreCase)))
            return (targets, "RTMP または RTMPS URL が必要です");
        return (targets, null);
    }

    private object Start(string title, IReadOnlyList<string>? selected, bool automatic)
    {
        var (targets, error) = ValidateTargets(selected);
        if (error != null) return new { ok = false, error };

        var ffmpeg = env.Get("FFMPEG_PATH", "ffmpeg");
        var ingest = env.Get("OBS_INGEST_URL", "rtmp://127.0.0.1:1935/live/stream");
        var tee = string.Join('|', targets.Select(t => "[f=flv:onfail=ignore]" + EscapeTee(t.url)));
        var start = new ProcessStartInfo(ffmpeg)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardErrorEncoding = Encoding.UTF8
        };
        foreach (var arg in new[] { "-hide_banner", "-loglevel", "info", "-listen", "1", "-i", ingest, "-map", "0", "-c", "copy", "-f", "tee", tee }) start.ArgumentList.Add(arg);
        var next = new Process { StartInfo = start };
        try { next.Start(); }
        catch (Win32Exception ex) when (ex.NativeErrorCode is 2 or 3) { next.Dispose(); return new { ok = false, error = "FFmpeg が見つかりません。FFMPEG_PATH を設定してください" }; }
        catch (Exception ex) { next.Dispose(); return new { ok = false, error = "FFmpeg 起動失敗: " + ex.Message }; }
        next.StandardInput.Close();
        lock (gate) { process = next; autoArm = automatic; }
        var outputs = targets.ToDictionary(t => t.platform, _ => new OutputHealth("waiting", "OBS映像の入力待ち"));
        state.SetStream(new StreamState(true, $"OBS 入力待機中 · {targets.Count} 配信先", targets.Count, outputs, null));
        _ = MonitorAsync(next, targets, generation);
        return new { ok = true, running = true, detail = "OBSの「配信開始」を押してください", obsStarted = false };
    }

    private static string EscapeTee(string value) => value.Replace("\\", "\\\\").Replace("|", "\\|").Replace("[", "\\[").Replace("]", "\\]");

    private async Task MonitorAsync(Process observed, List<(string platform, string url)> activeTargets, long session)
    {
        try
        {
            string? line;
            while ((line = await observed.StandardError.ReadLineAsync()) != null)
            {
                lock (gate)
                {
                    if (!ReferenceEquals(process, observed) || generation != session) continue;
                    var current = state.Stream;
                    var outputs = new Dictionary<string, OutputHealth>(current.Outputs);
                    var match = Regex.Match(line, @"Slave muxer #(\d+) failed", RegexOptions.IgnoreCase);
                    if (match.Success && int.TryParse(match.Groups[1].Value, out var index) && index >= 0 && index < activeTargets.Count)
                        outputs[activeTargets[index].platform] = new("failed", "RTMP接続に失敗しました");
                    else if (line.Contains("All tee outputs failed", StringComparison.OrdinalIgnoreCase))
                        foreach (var target in activeTargets) outputs[target.platform] = new("failed", "すべてのRTMP送信に失敗しました");
                    else if (Regex.IsMatch(line, @"frame\s*=\s*\d+", RegexOptions.IgnoreCase))
                        foreach (var target in activeTargets) if (outputs.GetValueOrDefault(target.platform)?.Status == "waiting") outputs[target.platform] = new("sending", "FFmpegからRTMP送信中");
                    if (!outputs.SequenceEqual(current.Outputs))
                        state.SetStream(current with { Outputs = outputs, StartedAt = current.StartedAt ?? (outputs.Values.Any(x => x.Status == "sending") ? DateTimeOffset.Now : null) });
                }
            }
            await observed.WaitForExitAsync();
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException) { }
        finally
        {
            var code = -1;
            try { code = observed.ExitCode; } catch { }
            bool shouldRearm = false;
            lock (gate)
            {
                if (ReferenceEquals(process, observed) && generation == session)
                {
                    process = null;
                    shouldRearm = autoArm && code == 0;
                    var current = state.Stream;
                    var outputs = current.Outputs.ToDictionary(p => p.Key, p => p.Value.Status == "failed" ? p.Value : new OutputHealth(code == 0 ? "stopped" : "failed", code == 0 ? "停止中" : "配信リレーが異常終了しました"));
                    state.SetStream(new StreamState(false, code == 0 ? "停止中" : $"FFmpeg 終了 ({code})", 0, outputs, null));
                }
            }
            observed.Dispose();
            if (shouldRearm)
            {
                await Task.Delay(1200);
                await operations.WaitAsync();
                try
                {
                    bool rearm;
                    lock (gate) rearm = autoArm && generation == session && process == null;
                    if (rearm) await StartCore("", activeTargets.Select(t => t.platform).ToArray(), true, false);
                }
                finally { operations.Release(); }
            }
        }
    }

    public object Stop()
    {
        Process? current;
        lock (gate)
        {
            generation++;
            autoArm = false; current = process; process = null;
            if (current != null)
            {
                try { if (!current.HasExited) { current.Kill(); current.WaitForExit(4000); } } catch (InvalidOperationException) { }
            }
            var outputs = state.Stream.Outputs.ToDictionary(p => p.Key, p => new OutputHealth("stopped", "停止中"));
            state.SetStream(new StreamState(false, "停止中", 0, outputs, null));
        }
        return new { ok = true, running = false, detail = "停止中" };
    }
}
