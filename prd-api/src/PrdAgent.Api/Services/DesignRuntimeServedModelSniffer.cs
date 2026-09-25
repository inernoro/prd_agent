using System.Text.Json;

namespace PrdAgent.Api.Services;

/// <summary>
/// 从网关回给设计执行器的响应里读出「这一次网关实际用哪个模型回答的」。
///
/// 为什么在 MAP 的模型出口读：OpenDesign 在执行服务（或 CDS 容器）里调模型，MAP 的执行器收不到网关的
/// Start 分片；但这些调用全部经过 MAP 的运行时模型代理，网关在响应里如实写着 model 字段
///（serving：有解析结果时就是 Resolution.ActualModel）。在这里读，拿到的是网关自己报的值，不是执行器自报。
///
/// 口径：
/// - 非流式 JSON：顶层 <c>model</c>（chat.completion / response 对象都在这里）。
/// - SSE：以流里**最后**出现的值为准。chat 分片取每行顶层 <c>model</c>；Responses 事件包着的
///   <c>response.model</c> 只认终态事件（completed / failed / incomplete）——网关在处理 Start 分片之前
///   就发出 <c>response.created</c>，那里写的是请求时的逻辑别名（如 default-chat-curated），不是实际模型。
///   代理在整条流转发完之后才读 <see cref="Model"/> 记录，所以中途出现的别名不会落库。
/// - 读不到、或只是占位值（auto / map-managed）就不报——不编一个（no-rootless-tree）。
/// 非流式只看前缀、找到就停；SSE 行先按字节查 <c>"model"</c>，没有就不解析，转发不因它多等待。
/// </summary>
internal sealed class DesignRuntimeServedModelSniffer
{
    /// <summary>非流式响应只看这么长的前缀：model 字段在对象开头，不值得为一整页 HTML 再解析一遍。</summary>
    internal const int MaxJsonPrefixBytes = 256 * 1024;

    /// <summary>SSE 单行上限：超长的行（整页正文的增量）直接跳过，不为找 model 攒它。</summary>
    internal const int MaxSseLineBytes = 64 * 1024;

    private static readonly HashSet<string> Placeholders = new(StringComparer.OrdinalIgnoreCase)
    {
        "auto", "map-managed", "dry-run",
    };

    private readonly bool _eventStream;
    private readonly MemoryStream _buffer = new();
    private bool _skippingLongLine;
    private bool _done;

    internal DesignRuntimeServedModelSniffer(bool eventStream)
    {
        _eventStream = eventStream;
    }

    /// <summary>目前为止可信的模型（SSE 为最后一次出现的值）；没找到为 null。整条响应转发完再读。</summary>
    internal string? Model { get; private set; }

    /// <summary>喂一段转发出去的字节。</summary>
    internal void Observe(ReadOnlySpan<byte> bytes)
    {
        if (_done || bytes.IsEmpty) return;
        if (_eventStream) ObserveEventStream(bytes);
        else ObserveJson(bytes);
    }

    private void ObserveJson(ReadOnlySpan<byte> bytes)
    {
        var room = MaxJsonPrefixBytes - (int)_buffer.Length;
        if (room <= 0)
        {
            _done = true;
            return;
        }
        _buffer.Write(bytes[..Math.Min(room, bytes.Length)]);
        // 非流式响应里的 model 就是终值：找到即停。
        if (Normalize(ReadTopLevelModel(_buffer.GetBuffer().AsSpan(0, (int)_buffer.Length))) is { } model)
        {
            Model = model;
            _done = true;
            _buffer.SetLength(0);
        }
    }

    private void ObserveEventStream(ReadOnlySpan<byte> bytes)
    {
        foreach (var b in bytes)
        {
            if (b == (byte)'\n')
            {
                if (!_skippingLongLine
                    && Normalize(ReadSseLine(_buffer.GetBuffer().AsSpan(0, (int)_buffer.Length))) is { } model)
                    Model = model;
                _buffer.SetLength(0);
                _skippingLongLine = false;
                continue;
            }
            if (_skippingLongLine) continue;
            if (_buffer.Length >= MaxSseLineBytes)
            {
                _skippingLongLine = true;
                _buffer.SetLength(0);
                continue;
            }
            _buffer.WriteByte(b);
        }
    }

    internal static string? Normalize(string? candidate)
    {
        var trimmed = candidate?.Trim();
        if (string.IsNullOrEmpty(trimmed) || trimmed.Length > 200 || Placeholders.Contains(trimmed)) return null;
        return trimmed;
    }

    private static string? ReadSseLine(ReadOnlySpan<byte> line)
    {
        if (line.Length > 0 && line[^1] == (byte)'\r') line = line[..^1];
        var prefix = "data:"u8;
        if (!line.StartsWith(prefix)) return null;
        var payload = line[prefix.Length..].Trim((byte)' ');
        if (payload.IsEmpty || payload[0] != (byte)'{') return null;
        // 绝大多数行是正文增量：不含 "model" 键就不解析。
        if (payload.IndexOf("\"model\""u8) < 0) return null;
        try
        {
            using var document = JsonDocument.Parse(payload.ToArray());
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (Normalize(StringProperty(root, "model")) is { } direct) return direct;
            // Responses 流把整个 response 对象包在 response 字段里。只认终态事件：response.created 在网关
            // 处理 Start 分片之前发出，里面是请求时的逻辑别名，不是实际模型。
            var type = StringProperty(root, "type");
            if (type is not ("response.completed" or "response.failed" or "response.incomplete")) return null;
            return root.TryGetProperty("response", out var response) && response.ValueKind == JsonValueKind.Object
                ? StringProperty(response, "model")
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>在一个可能不完整的 JSON 前缀里找顶层的 model 字符串属性。</summary>
    private static string? ReadTopLevelModel(ReadOnlySpan<byte> prefix)
    {
        var reader = new Utf8JsonReader(prefix, isFinalBlock: false, state: default);
        try
        {
            while (reader.Read())
            {
                if (reader.CurrentDepth == 1
                    && reader.TokenType == JsonTokenType.PropertyName
                    && reader.ValueTextEquals("model"u8))
                {
                    if (!reader.Read()) return null;
                    return reader.TokenType == JsonTokenType.String ? reader.GetString() : null;
                }
            }
        }
        catch (JsonException)
        {
            return null;
        }
        return null;
    }

    private static string? StringProperty(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
