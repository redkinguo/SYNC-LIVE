using System.ComponentModel;
using System.Diagnostics;

namespace ObsMultistreamRelay;

internal sealed class RelayWorker
{
    private readonly object gate = new();
    private Process? process;
    private bool stopRequested;

    public event Action<string, int>? Started;
    public event Action<string>? Log;
    public event Action<int, bool>? Exited;

    public bool Running
    {
        get { lock (gate) return process != null; }
    }

    public bool StopRequested
    {
        get { lock (gate) return stopRequested; }
    }

    public void Start(string ffmpegPath, int port, string path, IReadOnlyList<Destination> destinations)
    {
        lock (gate)
        {
            if (process != null) return;
            var executable = string.IsNullOrWhiteSpace(ffmpegPath) ? "ffmpeg" : ffmpegPath.Trim();
            var targets = destinations.Select(RelayConfig.TargetUrl).ToArray();
            if (targets.Length == 0) throw new ArgumentException("有効な配信先を1つ以上設定してください。");

            var inputUrl = $"rtmp://127.0.0.1:{port}/{(path.Trim('/').Length == 0 ? "live/obs" : path.Trim('/'))}";
            var start = new ProcessStartInfo(executable)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardErrorEncoding = System.Text.Encoding.UTF8
            };
            foreach (var arg in new[] { "-hide_banner", "-loglevel", "info", "-listen", "1", "-i", inputUrl })
                start.ArgumentList.Add(arg);
            foreach (var target in targets)
            {
                foreach (var arg in new[] { "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "flv", "-flvflags", "no_duration_filesize", target })
                    start.ArgumentList.Add(arg);
            }

            var next = new Process { StartInfo = start };
            try
            {
                if (!next.Start()) throw new IOException("FFmpegを起動できませんでした。");
            }
            catch (Win32Exception ex) when (ex.NativeErrorCode is 2 or 3)
            {
                next.Dispose();
                throw new FileNotFoundException("FFmpegが見つかりません。ffmpeg.exeの場所を指定してください。", ex);
            }
            catch
            {
                next.Dispose();
                throw;
            }

            next.StandardInput.Close();
            lock (gate)
            {
                process = next;
                stopRequested = false;
            }
            Started?.Invoke(inputUrl, targets.Length);
            _ = MonitorAsync(next, destinations.Select(d => d.StreamKey).Where(k => k.Length > 0).ToArray());
        }
    }

    private async Task MonitorAsync(Process observed, string[] secrets)
    {
        try
        {
            string? line;
            while ((line = await observed.StandardError.ReadLineAsync().ConfigureAwait(false)) != null)
            {
                foreach (var secret in secrets) line = line.Replace(secret, "********", StringComparison.Ordinal);
                if (line.Length > 0) Log?.Invoke(line);
            }
            await observed.WaitForExitAsync().ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException)
        {
            Log?.Invoke(ex.Message);
        }
        finally
        {
            int code;
            try { code = observed.ExitCode; }
            catch { code = -1; }
            bool requested;
            lock (gate)
            {
                requested = stopRequested;
                if (ReferenceEquals(process, observed)) process = null;
            }
            observed.Dispose();
            Exited?.Invoke(code, requested);
        }
    }

    public async Task StopAsync()
    {
        Process? current;
        lock (gate)
        {
            stopRequested = true;
            current = process;
        }
        if (current == null) return;
        try
        {
            if (current.HasExited) return;
            current.Kill();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
            try { await current.WaitForExitAsync(timeout.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) { if (!current.HasExited) current.Kill(entireProcessTree: true); }
        }
        catch (InvalidOperationException) { }
    }
}
