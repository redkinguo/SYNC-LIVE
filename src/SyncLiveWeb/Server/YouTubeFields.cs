using System.Text.Json.Nodes;

namespace SyncLiveWeb;

internal static class YouTubeFields
{
    public static JsonObject Pick(JsonNode? source, params string[] fields)
    {
        var result = new JsonObject();
        foreach (var field in fields) if (source?[field] is { } value) result[field] = value.DeepClone();
        return result;
    }
}
