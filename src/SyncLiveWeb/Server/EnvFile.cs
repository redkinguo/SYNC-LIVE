using System.Text;
using System.Text.Json;

namespace SyncLiveWeb;

internal sealed class EnvFile
{
    private readonly string path;
    private readonly Dictionary<string, string> values = new(StringComparer.OrdinalIgnoreCase);
    private readonly object gate = new();

    public EnvFile(string path)
    {
        this.path = path;
        if (!File.Exists(path)) return;
        foreach (var line in File.ReadAllLines(path, Encoding.UTF8))
        {
            var separator = line.IndexOf('=');
            if (separator < 1 || line.TrimStart().StartsWith('#')) continue;
            var key = line[..separator].Trim();
            var value = line[(separator + 1)..].Trim();
            if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
            {
                try { value = JsonSerializer.Deserialize<string>(value) ?? ""; }
                catch (JsonException) { value = value[1..^1]; }
            }
            else if (value.Length >= 2 && value[0] == '\'' && value[^1] == '\'') value = value[1..^1];
            values[key] = value;
        }
    }

    public string Get(string key, string fallback = "")
    {
        var environment = Environment.GetEnvironmentVariable(key);
        if (environment != null) return environment;
        lock (gate) return values.GetValueOrDefault(key, fallback);
    }

    public bool IsTrue(string key) => Get(key).Equals("true", StringComparison.OrdinalIgnoreCase);

    public void Save(IReadOnlyDictionary<string, string> changes)
    {
        lock (gate)
        {
            var lines = File.Exists(path) ? File.ReadAllLines(path, Encoding.UTF8).ToList() : [];
            foreach (var (key, value) in changes)
            {
                var safe = value.Replace("\r", "").Replace("\n", "");
                var index = lines.FindIndex(line => line.Split('=', 2)[0].Trim().Equals(key, StringComparison.OrdinalIgnoreCase));
                var encoded = JsonSerializer.Serialize(safe);
                if (index >= 0) lines[index] = $"{key}={encoded}";
                else lines.Add($"{key}={encoded}");
            }
            var temporary = path + ".tmp";
            File.WriteAllLines(temporary, lines, new UTF8Encoding(false));
            File.Move(temporary, path, true);
            foreach (var (key, value) in changes) values[key] = value.Replace("\r", "").Replace("\n", "");
        }
    }
}
