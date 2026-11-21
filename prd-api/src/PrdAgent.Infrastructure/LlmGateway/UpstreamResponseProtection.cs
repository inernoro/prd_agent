using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;

namespace PrdAgent.Infrastructure.LlmGateway;

// 配置缺失意味着尚未批准通用上限；不得把测试候选值变成生产默认值。
internal sealed record UpstreamResponseBudget(long? ResponseBytes = null, long? EventBytes = null,
    long? OutputBytes = null, long? BufferedPrefixBytes = null, long? MediaResponseBytes = null)
{
    public static UpstreamResponseBudget Read(IConfiguration? config)
    {
        long? ReadLimit(string name)
        {
            var value = config?[$"LlmGateway:ResponseBudget:{name}"];
            if (value is null) return null;
            if (!long.TryParse(value, out var limit) || limit <= 0)
                throw new InvalidOperationException($"LlmGateway:ResponseBudget:{name} 必须为正整数字节数");
            return limit;
        }
        return new(ReadLimit("ResponseBytes"), ReadLimit("EventBytes"), ReadLimit("OutputBytes"),
            MediaResponseBytes: ReadLimit("MediaResponseBytes"));
    }
}

internal sealed class UpstreamResponseRejectedException(string code, int upstreamStatus, string reason) : IOException(
    $"上游响应已拒绝（HTTP {upstreamStatus}）：{reason}；原请求可能已执行，请勿自动重试")
{
    public string Code { get; } = code;
}

// 请求级检查器：活动凭据来自本次实际出站快照及请求头，不查询其他租户的秘密。
internal sealed class UpstreamResponseInspector
{
    private static readonly HashSet<string> SensitiveKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "authorization", "proxyauthorization", "xapikey", "apikey", "password", "secret",
        "accesstoken", "refreshtoken", "token", "cookie", "setcookie"
    };
    private static readonly HashSet<string> IncrementalFields = new(StringComparer.Ordinal)
        { "content", "text", "thinking", "reasoning_content", "reasoning", "arguments", "partial_json", "delta" };
    private static readonly Regex JsonString = new("\\\"(?:[^\\\"\\\\]|\\\\.)*\\\"", RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));
    private static readonly Regex JsonEscape = new(@"\\u([0-9a-fA-F]{4})|\\([""\\/bfnrt])",
        RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private readonly string[] _secrets;
    private readonly Dictionary<string, string> _tails = new(StringComparer.Ordinal);
    private readonly UpstreamResponseBudget _budget;
    private readonly int _status;
    private long _outputBytes;
    private bool _completed;
    public bool HasPendingPrefix => !_completed && _tails.Values.Any(x => x.Length != 0);
    public static bool IsSensitiveKey(string name) => SensitiveKeys.Contains(name.Replace("-", "").Replace("_", ""));

    public UpstreamResponseInspector(IEnumerable<string?> secrets, UpstreamResponseBudget budget, int status)
    {
        _budget = budget; _status = status;
        _secrets = secrets.Where(x => !string.IsNullOrEmpty(x)).SelectMany(x => new[]
            { x!, Uri.EscapeDataString(x!), Convert.ToBase64String(Encoding.UTF8.GetBytes(x!)) })
            .Distinct(StringComparer.Ordinal).ToArray();
    }

    public void CheckLiteral(string text)
    {
        if (_secrets.Any(secret => text.Contains(secret, StringComparison.Ordinal))) RejectCredential();
    }

    public void CheckBody(ReadOnlySpan<byte> bytes)
    {
        foreach (var secret in _secrets)
            if (bytes.IndexOf(Encoding.UTF8.GetBytes(secret)) >= 0) RejectCredential();
        // 二进制仍做精确字节匹配；结构化正文以 UTF-8 解码检查转义字段。
        CheckJson(Encoding.UTF8.GetString(bytes), incremental: false);
    }

    public void CheckEvent(string data) => CheckJson(data, incremental: true);

    private void CheckJson(string data, bool incremental)
    {
        CheckLiteral(data);
        // 即使引号未闭合，也检查已完整到达的 JSON 转义秘密；不修复或重写返回内容。
        if (data.Contains('\\'))
            CheckLiteral(JsonEscape.Replace(data, m => m.Groups[1].Success
                ? ((char)Convert.ToInt32(m.Groups[1].Value, 16)).ToString()
                : m.Groups[2].Value switch { "b" => "\b", "f" => "\f", "n" => "\n", "r" => "\r", "t" => "\t", var value => value }));
        if (data.Contains('%')) CheckLiteral(Uri.UnescapeDataString(data));
        if (data is "[DONE]") { _completed = true; return; }
        if (string.IsNullOrWhiteSpace(data)) return;
        try
        {
            using var doc = JsonDocument.Parse(data);
            var scope = "";
            if (incremental && doc.RootElement.ValueKind == JsonValueKind.Object)
                foreach (var key in new[] { "index", "output_index", "content_index", "item_id" })
                    if (doc.RootElement.TryGetProperty(key, out var identity)) scope += "/" + key + ":" + identity.GetRawText();
            Visit(doc.RootElement, scope, "", incremental);
            if (incremental && IsTerminal(doc.RootElement)) _completed = true;
        }
        catch (JsonException)
        {
            // 畸形 JSON 也不能利用转义隐藏已知凭据；只扫描完整字符串 token，不尝试修复正文。
            foreach (Match match in JsonString.Matches(data))
            {
                string? value;
                try { value = JsonSerializer.Deserialize<string>(match.Value); }
                catch (JsonException) { continue; }
                if (value is null) continue;
                CheckLiteral(value);
                if (IsSensitiveKey(value) && data.AsSpan(match.Index + match.Length).TrimStart().StartsWith(":"))
                    RejectCredential();
            }
        }
    }

    private static bool IsTerminal(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return false;
        if (root.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String
            && type.GetString() is "message_stop" or "response.completed" or "response.failed" or "response.incomplete") return true;
        if (root.TryGetProperty("delta", out var delta) && delta.ValueKind == JsonValueKind.Object
            && delta.TryGetProperty("stop_reason", out var stop) && stop.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(stop.GetString())) return true;
        return root.TryGetProperty("choices", out var choices) && choices.ValueKind == JsonValueKind.Array
            && choices.EnumerateArray().Any(choice => choice.ValueKind == JsonValueKind.Object
                && choice.TryGetProperty("finish_reason", out var finish) && finish.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(finish.GetString()));
    }

    private void Visit(JsonElement element, string path, string field, bool incremental)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                // OpenAI logprobs.token 是采样词元，不是认证 token；其值仍检查活动秘密。
                var logprobToken = property.Name == "token" && path.Contains("/logprobs/", StringComparison.Ordinal);
                if (IsSensitiveKey(property.Name) && !logprobToken && property.Value.ValueKind != JsonValueKind.Null) RejectCredential();
                Visit(property.Value, path + "/" + property.Name, property.Name, incremental);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            var index = 0;
            foreach (var item in element.EnumerateArray())
            {
                // 工具增量数组可只携带其中一个 index；不能把不同工具参数拼成同一条流。
                var identity = item.ValueKind == JsonValueKind.Object && item.TryGetProperty("index", out var id)
                    && id.ValueKind == JsonValueKind.Number ? id.GetRawText() : index.ToString();
                Visit(item, path + "/" + identity, field, incremental);
                index++;
            }
        }
        else if (element.ValueKind == JsonValueKind.String)
        {
            var value = element.GetString()!;
            CheckLiteral(value);
            // 工具 name/id 是既有网关的快照字段，只有参数按增量拼接。
            if (!IncrementalFields.Contains(field)) return;
            if (incremental && _completed && value.Length > 0)
                throw new UpstreamResponseRejectedException("UPSTREAM_PROTOCOL_VIOLATION", _status, "终态之后仍收到输出，后续正文已省略");
            _outputBytes = checked(_outputBytes + Encoding.UTF8.GetByteCount(value));
            if (_budget.OutputBytes is { } max && _outputBytes > max) RejectLimit($"累计输出超过已配置字节预算（已读{_outputBytes}，预算{max}字节）");
            if (!incremental) return;
            var joined = _tails.GetValueOrDefault(path, "") + value;
            CheckLiteral(joined);
            var keep = 0;
            foreach (var secret in _secrets)
                for (var length = Math.Min(secret.Length - 1, joined.Length); length > keep; length--)
                    if (joined.EndsWith(secret[..length], StringComparison.Ordinal)) { keep = length; break; }
            if (keep == 0) _tails.Remove(path);
            else _tails[path] = joined[^keep..];
        }
    }

    public void RejectCredential() => throw new UpstreamResponseRejectedException(
        "UPSTREAM_CREDENTIAL_REFLECTION", _status, "检测到凭据回显，正文已省略");
    public void RejectLimit(string reason) => throw new UpstreamResponseRejectedException("UPSTREAM_RESPONSE_TOO_LARGE", _status, reason);
}

internal sealed class ProtectedUpstreamHandler(HttpClient client, IEnumerable<string?> secrets,
    UpstreamResponseBudget budget, bool lineEvents, Action<HttpResponseMessage> trackResponse) : HttpMessageHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var active = secrets.ToList();
        foreach (var header in request.Headers)
        {
            if (!UpstreamResponseInspector.IsSensitiveKey(header.Key)
                && !(header.Key.Contains("Api", StringComparison.OrdinalIgnoreCase) && header.Key.Contains("Key", StringComparison.OrdinalIgnoreCase))) continue;
            foreach (var value in header.Value)
            {
                active.Add(value);
                if (header.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase)) active.Add(request.Headers.Authorization?.Parameter);
            }
        }
        HttpResponseMessage response;
        // HttpClient 不允许再次发送同一个封套。这里只复制封套；共享请求体仍由原请求拥有。
        var forward = new HttpRequestMessage(request.Method, request.RequestUri)
        {
            Content = request.Content, Version = request.Version, VersionPolicy = request.VersionPolicy
        };
        foreach (var h in request.Headers) forward.Headers.TryAddWithoutValidation(h.Key, h.Value);
        foreach (var option in request.Options) forward.Options.Set(new HttpRequestOptionsKey<object?>(option.Key), option.Value);
        try { response = await client.SendAsync(forward, HttpCompletionOption.ResponseHeadersRead, ct); }
        catch (HttpRequestException ex)
        {
            // 不保存包含 URL、代理凭据或响应原因的原异常；保留连接阶段，供既有安全重试判定。
            var socket = ex.InnerException as System.Net.Sockets.SocketException;
            throw new HttpRequestException(ex.HttpRequestError, "上游网络传输失败",
                socket is null ? null : new System.Net.Sockets.SocketException((int)socket.SocketErrorCode), ex.StatusCode);
        }
        catch (OperationCanceledException) { throw new OperationCanceledException("上游请求取消或超时", ct); }
        catch (Exception) { throw new IOException("上游请求传输失败，原始异常已省略"); }
        var inspector = new UpstreamResponseInspector(active, budget, (int)response.StatusCode);
        try
        {
            foreach (var headers in new[] { (System.Net.Http.Headers.HttpHeaders)response.Headers, response.Content.Headers })
                foreach (var header in headers.ToArray())
                {
                    if (UpstreamResponseInspector.IsSensitiveKey(header.Key)) { headers.Remove(header.Key); continue; }
                    foreach (var value in header.Value) inspector.CheckLiteral(value);
                }
            // ReasonPhrase 也属于不可信供应方文本。
            if (response.ReasonPhrase is { } reason) inspector.CheckLiteral(reason);
            if (budget.ResponseBytes is { } max && response.Content.Headers.ContentLength > max)
                inspector.RejectLimit($"响应长度声明超过已配置字节预算（声明{response.Content.Headers.ContentLength}，预算{max}字节）");
            var sse = (lineEvents && response.IsSuccessStatusCode) || response.Content.Headers.ContentType?.MediaType == "text/event-stream";
            response.Content = new ProtectedUpstreamContent(response.Content, inspector, budget, sse, lineEvents);
            trackResponse(response);
            return response;
        }
        catch { response.Dispose(); throw; }
    }
}

internal sealed class ProtectedUpstreamContent : HttpContent
{
    private readonly HttpContent _inner;
    private readonly UpstreamResponseInspector _inspector;
    private readonly UpstreamResponseBudget _budget;
    private readonly bool _sse, _lineEvents;
    public ProtectedUpstreamContent(HttpContent inner, UpstreamResponseInspector inspector, UpstreamResponseBudget budget, bool sse, bool lineEvents)
    {
        _inner = inner; _inspector = inspector; _budget = budget; _sse = sse; _lineEvents = lineEvents;
        foreach (var h in inner.Headers) Headers.TryAddWithoutValidation(h.Key, h.Value);
        // 不让 HttpContent 按不可信长度预分配；读取器已检查声明及实际字节。
        Headers.Remove("Content-Length");
    }
    protected override bool TryComputeLength(out long length) { length = 0; return false; }
    protected override Task<Stream> CreateContentReadStreamAsync() => CreateContentReadStreamAsync(CancellationToken.None);
    protected override async Task<Stream> CreateContentReadStreamAsync(CancellationToken ct)
    {
        try { return await ReadCheckedContentAsync(ct); }
        catch (OperationCanceledException ex) { throw new OperationCanceledException("上游读取取消或超时", ex.CancellationToken); }
        catch (Exception ex) when (ex is not UpstreamResponseRejectedException and not OperationCanceledException)
        { throw new IOException("上游响应读取失败，原始异常已省略"); }
    }
    private async Task<Stream> ReadCheckedContentAsync(CancellationToken ct)
    {
        var input = await _inner.ReadAsStreamAsync(ct);
        if (_sse) return new ProtectedSseStream(input, _inspector, _budget, _lineEvents);
        var buffer = new MemoryStream();
        try
        {
            var chunk = new byte[8192];
            while (true)
            {
                var remaining = _budget.ResponseBytes is { } max ? (int)(Math.Min(chunk.Length - 1L, max - buffer.Length) + 1) : chunk.Length;
                // 已有媒体转换器用 limit+1 前缀生成自己的失败码和截断审计；保留这份合同。
                if (_budget.BufferedPrefixBytes is { } prefixMax)
                    remaining = (int)Math.Min(remaining, prefixMax - buffer.Length);
                if (remaining == 0) break;
                var count = await input.ReadAsync(chunk.AsMemory(0, remaining), ct);
                if (count == 0) break;
                if (_budget.ResponseBytes is { } limit && buffer.Length + count > limit)
                    _inspector.RejectLimit($"响应超过已配置字节预算（已读{buffer.Length + count}，预算{limit}字节；总长未知）");
                buffer.Write(chunk, 0, count);
            }
            _inspector.CheckBody(buffer.GetBuffer().AsSpan(0, checked((int)buffer.Length)));
            buffer.Position = 0;
            return buffer;
        }
        catch { buffer.Dispose(); throw; }
    }
    protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => SerializeToStreamAsync(stream, context, CancellationToken.None);
    protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context, CancellationToken ct)
    {
        using var safe = await CreateContentReadStreamAsync(ct);
        await safe.CopyToAsync(stream, ct);
    }
    protected override void Dispose(bool disposing) { if (disposing) _inner.Dispose(); base.Dispose(disposing); }
}

// 保留原始 SSE 字节与事件顺序。可能是秘密前缀的事件暂存，确认安全后再交付；
// 出现完整秘密时，整个待交付窗口被丢弃。EOF 的不完整前缀不是完整凭据，可原样交付。
internal sealed class ProtectedSseStream(Stream input, UpstreamResponseInspector inspector,
    UpstreamResponseBudget budget, bool lineEvents) : Stream
{
    private readonly byte[] _readBuffer = new byte[8192];
    private const int MaxRetainedFrameCapacity = 128 * 1024;
    private readonly MemoryStream _frameBuffer = new();
    private int _readOffset, _readCount;
    private long _wireBytes;
    private readonly Queue<byte[]> _pending = new();
    private readonly Queue<byte[]> _ready = new();
    private byte[]? _current;
    private int _offset;
    private bool _eof;
    public override async ValueTask<int> ReadAsync(Memory<byte> destination, CancellationToken ct = default)
    {
        try { return await ReadCheckedAsync(destination, ct); }
        catch (OperationCanceledException ex) { throw new OperationCanceledException("上游流读取取消或超时", ex.CancellationToken); }
        catch (Exception ex) when (ex is not UpstreamResponseRejectedException and not OperationCanceledException)
        { throw new IOException("上游流读取失败，原始异常已省略"); }
    }
    private async ValueTask<int> ReadCheckedAsync(Memory<byte> destination, CancellationToken ct)
    {
        if (destination.Length == 0) return 0;
        while (_current is null || _offset == _current.Length)
        {
            _current = null; _offset = 0;
            if (_ready.TryDequeue(out _current)) break;
            if (_eof) return 0;
            var frame = await ReadFrameAsync(ct);
            if (frame is null) _eof = true;
            else
            {
                var text = Encoding.UTF8.GetString(frame);
                inspector.CheckLiteral(text);
                var data = string.Join("\n", text.Split('\n').Where(x => x.StartsWith("data:", StringComparison.Ordinal))
                    .Select(x => x[5..].TrimStart(' ').TrimEnd('\r')));
                inspector.CheckEvent(data);
                _pending.Enqueue(frame);
            }
            if (_eof || !inspector.HasPendingPrefix)
                while (_pending.TryDequeue(out var safe)) _ready.Enqueue(safe);
        }
        var count = Math.Min(destination.Length, _current!.Length - _offset);
        _current.AsMemory(_offset, count).CopyTo(destination); _offset += count;
        return count;
    }
    private async Task<byte[]?> ReadFrameAsync(CancellationToken ct)
    {
        try
        {
            return await ReadFrameCoreAsync(_frameBuffer, ct);
        }
        finally
        {
            // Queued frames own their byte arrays. Reuse only the temporary assembler,
            // and release unusually large backing arrays at the end of the frame.
            _frameBuffer.SetLength(0);
            if (_frameBuffer.Capacity > MaxRetainedFrameCapacity) _frameBuffer.Capacity = 0;
        }
    }
    private async Task<byte[]?> ReadFrameCoreAsync(MemoryStream frame, CancellationToken ct)
    {
        var lineHasContent = false;
        while (true)
        {
            if (_readOffset == _readCount)
            {
                var remaining = budget.ResponseBytes is { } max ? (int)(Math.Min(_readBuffer.Length - 1L, max - _wireBytes) + 1) : _readBuffer.Length;
                _readCount = await input.ReadAsync(_readBuffer.AsMemory(0, remaining), ct); _readOffset = 0;
                if (_readCount == 0) return frame.Length == 0 ? null : frame.ToArray();
                _wireBytes = checked(_wireBytes + _readCount);
                if (budget.ResponseBytes is { } limit && _wireBytes > limit) inspector.RejectLimit($"累计 SSE 超过已配置字节预算（已读{_wireBytes}，预算{limit}字节；总长未知）");
            }
            var value = _readBuffer[_readOffset++];
            if (budget.EventBytes is { } eventMax && frame.Length >= eventMax) inspector.RejectLimit($"SSE 事件超过已配置字节预算（已读{frame.Length + 1}，预算{eventMax}字节）");
            frame.WriteByte(value);
            if (value == '\n')
            {
                if (lineEvents || !lineHasContent) return frame.ToArray();
                lineHasContent = false;
            }
            else if (value != '\r') lineHasContent = true;
        }
    }
    public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) => ReadAsync(buffer.AsMemory(offset, count), ct).AsTask();
    protected override void Dispose(bool disposing) { if (disposing) { input.Dispose(); _frameBuffer.Dispose(); _pending.Clear(); _ready.Clear(); } base.Dispose(disposing); }
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
