using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace SyncLiveWeb;

internal static class ObsControl
{
    public static async Task Request(string address, string password, string requestType)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        using var socket = new ClientWebSocket();
        socket.Options.AddSubProtocol("obswebsocket.json");
        await socket.ConnectAsync(new Uri(address), timeout.Token);
        using var hello = await Receive(socket, timeout.Token);
        if (hello.RootElement.GetProperty("op").GetInt32() != 0) throw new InvalidOperationException("OBS WebSocket のHelloを受信できませんでした");
        var data = hello.RootElement.GetProperty("d");
        string? authentication = null;
        if (data.TryGetProperty("authentication", out var challenge))
        {
            var salt = challenge.GetProperty("salt").GetString() ?? "";
            var nonce = challenge.GetProperty("challenge").GetString() ?? "";
            var secret = Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(password + salt)));
            authentication = Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(secret + nonce)));
        }
        await Send(socket, new { op = 1, d = new { rpcVersion = 1, authentication } }, timeout.Token);
        using var identified = await Receive(socket, timeout.Token);
        if (identified.RootElement.GetProperty("op").GetInt32() != 2) throw new InvalidOperationException("OBS WebSocket の認証に失敗しました");
        var id = Guid.NewGuid().ToString();
        await Send(socket, new { op = 6, d = new { requestType, requestId = id } }, timeout.Token);
        while (true)
        {
            using var response = await Receive(socket, timeout.Token);
            if (response.RootElement.GetProperty("op").GetInt32() != 7) continue;
            var result = response.RootElement.GetProperty("d");
            if (result.GetProperty("requestId").GetString() != id) continue;
            var status = result.GetProperty("requestStatus");
            if (!status.GetProperty("result").GetBoolean()) throw new InvalidOperationException("OBS: " + (status.TryGetProperty("comment", out var comment) ? comment.GetString() : "操作に失敗しました"));
            break;
        }
        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Done", timeout.Token);
    }

    private static async Task Send(ClientWebSocket socket, object value, CancellationToken cancellation) =>
        await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(value), WebSocketMessageType.Text, true, cancellation);

    private static async Task<JsonDocument> Receive(ClientWebSocket socket, CancellationToken cancellation)
    {
        using var buffer = new MemoryStream();
        var part = new byte[8192];
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(part, cancellation);
            if (result.MessageType == WebSocketMessageType.Close) throw new InvalidOperationException("OBS WebSocket が接続を閉じました");
            buffer.Write(part, 0, result.Count);
        } while (!result.EndOfMessage);
        return JsonDocument.Parse(buffer.ToArray());
    }
}
