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
/// - SSE：每个 <c>data:</c> 行里的 <c>model</c>，或 Responses 事件里的 <c>response.model</c>，取第一次出现的。
/// - 读不到、或只是占位值（auto / map-managed）就不报——不编一个（no-rootless-tree）。
/// 只看前缀、找到就停，代理的逐字节转发不因它多拷贝或多等待。
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

    /// <summary>找到的模型；没找到为 null。</summary>
    internal string? Model { get; private set; }

    /// <summary>喂一段转发出去的字节；本次喂入后第一次找到模型时返回它，否则返回 null。</summary>
    internal string? Observe(ReadOnlySpan<byte> bytes)
    {
        if (_done || bytes.IsEmpty) return null;
        return _eventStream ? ObserveEventStream(bytes) : ObserveJson(bytes);
    }

    private string? ObserveJson(ReadOnlySpan<byte> bytes)
    {
        var room = MaxJsonPrefixBytes - (int)_buffer.Length;
        if (room <= 0)
        {
            _done = true;
            return null;
        }
        _buffer.Write(bytes[..Math.Min(room, bytes.Length)]);
        var found = ReadTopLevelModel(_buffer.GetBuffer().AsSpan(0, (int)_buffer.Length));
        return Found(found);
    }

    private string? ObserveEventStream(ReadOnlySpan<byte> bytes)
    {
        foreach (var b in bytes)
        {
            if (b == (byte)'\n')
            {
                if (!_skippingLongLine)
                {
                    var found = ReadSseLine(_buffer.GetBuffer().AsSpan(0, (int)_buffer.Length));
                    if (Found(found) is { } model)
                    {
                        _buffer.SetLength(0);
                        return model;
                    }
                }
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
        return null;
    }

    private string? Found(string? candidate)
    {
        var model = Normalize(candidate);
        if (model == null) return null;
        Model = model;
        _done = true;
        _buffer.SetLength(0);
        return model;
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
        try
        {
            using var document = JsonDocument.Parse(payload.ToArray());
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (Normalize(StringProperty(root, "model")) is { } direct) return direct;
            // Responses 流：response.created / response.completed 事件把整个 response 对象包在 response 字段里。
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
