using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace ObsMultistreamRelay;

internal sealed class Destination
{
    public string Name { get; set; } = "配信先";
    public bool Enabled { get; set; }
    public string Server { get; set; } = "";
    public string StreamKey { get; set; } = "";
}

internal sealed class RelayConfig
{
    public int Port { get; set; } = 1935;
    public string Path { get; set; } = "live/obs";
    public string FfmpegPath { get; set; } = "ffmpeg";
    public bool AutoRestart { get; set; } = true;
    public List<Destination> Destinations { get; set; } = DefaultDestinations();

    private static List<Destination> DefaultDestinations() =>
    [
        new() { Name = "YouTube", Enabled = true, Server = "rtmps://a.rtmps.youtube.com/live2" },
        new() { Name = "Kick", Enabled = true }
    ];

    public static string ConfigPath => System.IO.Path.Combine(AppContext.BaseDirectory, "data", "Relay", "config.json");

    public static RelayConfig Load()
    {
        if (!File.Exists(ConfigPath)) return new();
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(ConfigPath, Encoding.UTF8));
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return new();
            var config = new RelayConfig
            {
                Port = Number(root, "port", 1935),
                Path = String(root, "path", "live/obs"),
                FfmpegPath = String(root, "ffmpeg_path", "ffmpeg"),
                AutoRestart = Boolean(root, "auto_restart", true)
            };
            if (root.TryGetProperty("destinations", out var items) && items.ValueKind == JsonValueKind.Array && items.GetArrayLength() > 0)
            {
                config.Destinations = [];
                foreach (var item in items.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object) continue;
                    if (String(item, "name", "").Equals("TikTok", StringComparison.OrdinalIgnoreCase)) continue;
                    var protectedKey = String(item, "stream_key_protected", String(item, "stream_key", ""));
                    string key;
                    try { key = Dpapi.Unprotect(protectedKey); }
                    catch { key = ""; }
                    config.Destinations.Add(new Destination
                    {
                        Name = String(item, "name", "配信先"),
                        Enabled = Boolean(item, "enabled", false),
                        Server = String(item, "server", ""),
                        StreamKey = key
                    });
                }
            }
            return config;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return new();
        }
    }

    public void Save()
    {
        var payload = new
        {
            port = Port,
            path = Path,
            ffmpeg_path = FfmpegPath,
            auto_restart = AutoRestart,
            destinations = Destinations.Select(item => new
            {
                name = item.Name,
                enabled = item.Enabled,
                server = item.Server,
                stream_key_protected = Dpapi.Protect(item.StreamKey)
            }).ToArray()
        };
        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true });
        var temporary = ConfigPath + ".tmp";
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(ConfigPath)!);
        File.WriteAllText(temporary, json, Encoding.UTF8);
        File.Move(temporary, ConfigPath, true);
    }

    private static string String(JsonElement item, string name, string fallback) =>
        item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? fallback : fallback;
    private static int Number(JsonElement item, string name, int fallback) =>
        item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) ? number : fallback;
    private static bool Boolean(JsonElement item, string name, bool fallback) =>
        item.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : fallback;

    public static string TargetUrl(Destination item)
    {
        var server = item.Server.Trim();
        var key = item.StreamKey.Trim().TrimStart('/');
        if (server.Length == 0 || key.Length == 0) throw new ArgumentException("サーバーURLとストリームキーを入力してください。");
        if (!Regex.IsMatch(server, @"^[a-zA-Z][a-zA-Z0-9+.-]*://"))
            throw new ArgumentException("サーバーURLはrtmp://またはrtmps://から始めてください。");
        return server.TrimEnd('/') + "/" + key;
    }
}

internal static class Dpapi
{
    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int Length;
        public IntPtr Data;
    }

    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(ref DataBlob data, string description, IntPtr entropy,
        IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(ref DataBlob data, IntPtr description, IntPtr entropy,
        IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static string Protect(string value)
    {
        if (value.Length == 0) return "";
        var raw = Encoding.UTF8.GetBytes(value);
        var input = new DataBlob { Length = raw.Length, Data = Marshal.AllocHGlobal(raw.Length) };
        try
        {
            Marshal.Copy(raw, 0, input.Data, raw.Length);
            if (!CryptProtectData(ref input, "OBS Multistream Relay", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out var output))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                var encrypted = new byte[output.Length];
                Marshal.Copy(output.Data, encrypted, 0, encrypted.Length);
                return "dpapi:" + Convert.ToBase64String(encrypted);
            }
            finally { LocalFree(output.Data); }
        }
        finally { Marshal.FreeHGlobal(input.Data); }
    }

    public static string Unprotect(string value)
    {
        if (value.Length == 0 || !value.StartsWith("dpapi:", StringComparison.Ordinal)) return value;
        var raw = Convert.FromBase64String(value[6..]);
        var input = new DataBlob { Length = raw.Length, Data = Marshal.AllocHGlobal(raw.Length) };
        try
        {
            Marshal.Copy(raw, 0, input.Data, raw.Length);
            if (!CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out var output))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                var decrypted = new byte[output.Length];
                Marshal.Copy(output.Data, decrypted, 0, decrypted.Length);
                return Encoding.UTF8.GetString(decrypted);
            }
            finally { LocalFree(output.Data); }
        }
        finally { Marshal.FreeHGlobal(input.Data); }
    }
}
