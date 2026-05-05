using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.ClaudeSidecar;

/// <summary>
/// 多实例 sidecar 路由 + SSE 流式调用。
/// 跨服务器/sandbox：仅由 BaseUrl 与 Tags 区分，业务无感知。
/// 健康状态由 ClaudeSidecarHealthChecker（HostedService）周期写入 _state。
/// </summary>
public sealed class ClaudeSidecarRouter : IClaudeSidecarRouter
{
    public const string HttpClientName = "claude-sidecar";

    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly IHttpClientFactory _httpFactory;
    private readonly IOptionsMonitor<ClaudeSidecarOptions> _options;
    private readonly ILogger<ClaudeSidecarRouter> _logger;
    private readonly InstanceStateRegistry _state;

    public ClaudeSidecarRouter(
        IHttpClientFactory httpFactory,
        IOptionsMonitor<ClaudeSidecarOptions> options,
        InstanceStateRegistry state,
        ILogger<ClaudeSidecarRouter> logger)
    {
        _httpFactory = httpFactory;
        _options = options;
        _state = state;
        _logger = logger;
    }

    public bool IsConfigured =>
        _options.CurrentValue.Enabled && _options.CurrentValue.Sidecars.Count > 0;

    public int InstanceCount => _options.CurrentValue.Sidecars.Count;

    public int HealthyCount => _state.CountHealthy();

    public async IAsyncEnumerable<SidecarEvent> RunStreamAsync(
        SidecarRunRequest request,
        [EnumeratorCancellation] CancellationToken ct)
    {
        if (!IsConfigured)
        {
            yield return new SidecarEvent
            {
                Type = SidecarEventType.Error,
                ErrorCode = "sidecar_not_configured",
                Message = "ClaudeSdkExecutor 未启用或未配置任何 Sidecar 实例",
            };
            yield break;
        }

        var instance = PickInstance(request);
        if (instance == null)
        {
            yield return new SidecarEvent
            {
                Type = SidecarEventType.Error,
                ErrorCode = "no_healthy_sidecar",
                Message = "所有 sidecar 实例均不健康",
            };
            yield break;
        }

        var token = ResolveToken(instance);
        if (string.IsNullOrWhiteSpace(token))
        {
            yield return new SidecarEvent
            {
                Type = SidecarEventType.Error,
                ErrorCode = "sidecar_token_missing",
                Message = $"sidecar '{instance.Name}' 未配置 Token / TokenEnvVar",
            };
            yield break;
        }

        var url = CombineUrl(instance.BaseUrl, "/v1/agent/run");
        _logger.LogInformation(
            "[ClaudeSdk] dispatch run={RunId} sidecar={Name} url={Url}",
            request.RunId, instance.Name, url);

        var http = _httpFactory.CreateClient(HttpClientName);
        http.Timeout = Timeout.InfiniteTimeSpan;

        using var httpReq = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = SerializeBody(request),
        };
        httpReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        httpReq.Headers.Accept.ParseAdd("text/event-stream");

        // C# 不允许 `yield return` 出现在 try-catch 中，所以把"发请求 + 拿响应流"
        // 拆到独立 helper，由本方法只在异常路径上构造一次性的错误事件。
        var dispatch = await DispatchAsync(http, httpReq, instance, ct);
        if (dispatch.ErrorEvent != null)
        {
            yield return dispatch.ErrorEvent;
            yield break;
        }

        await using var stream = dispatch.Stream!;
        using var response = dispatch.Response!;

        await foreach (var ev in ParseSseAsync(stream, instance.Name, ct))
        {
            yield return ev;
            if (ev.Type == SidecarEventType.Done || ev.Type == SidecarEventType.Error)
                yield break;
        }
    }

    private async Task<DispatchResult> DispatchAsync(
        HttpClient http,
        HttpRequestMessage httpReq,
        SidecarInstanceConfig instance,
        CancellationToken ct)
    {
        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(httpReq, HttpCompletionOption.ResponseHeadersRead, ct);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            _state.RecordFailure(instance.Name);
            return new DispatchResult
            {
                ErrorEvent = new SidecarEvent
                {
                    Type = SidecarEventType.Error,
                    ErrorCode = "sidecar_dispatch_error",
                    Message = ex.Message,
                    SidecarName = instance.Name,
                },
            };
        }

        if (!response.IsSuccessStatusCode)
        {
            _state.RecordFailure(instance.Name);
            var body = await SafeReadString(response, ct);
            response.Dispose();
            return new DispatchResult
            {
                ErrorEvent = new SidecarEvent
                {
                    Type = SidecarEventType.Error,
                    ErrorCode = $"sidecar_http_{(int)response.StatusCode}",
                    Message = body,
                    SidecarName = instance.Name,
                },
            };
        }

        _state.RecordSuccess(instance.Name);
        var stream = await response.Content.ReadAsStreamAsync(ct);
        return new DispatchResult { Response = response, Stream = stream };
    }

    private sealed class DispatchResult
    {
        public HttpResponseMessage? Response { get; init; }
        public Stream? Stream { get; init; }
        public SidecarEvent? ErrorEvent { get; init; }
    }

    private SidecarInstanceConfig? PickInstance(SidecarRunRequest req)
    {
        var opts = _options.CurrentValue;
        var candidates = opts.Sidecars.AsEnumerable();

        if (!string.IsNullOrWhiteSpace(req.SidecarTag))
        {
            var tagged = candidates
                .Where(s => s.Tags.Contains(req.SidecarTag!, StringComparer.OrdinalIgnoreCase))
                .ToList();
            if (tagged.Count > 0) candidates = tagged;
        }

        var alive = candidates.Where(s => _state.IsHealthy(s.Name)).ToList();
        if (alive.Count == 0)
        {
            // 没有健康实例时，做一次最后挣扎：用未标记不健康的全集（首次启动尚未有探测结果）
            alive = candidates.Where(s => !_state.IsKnownUnhealthy(s.Name)).ToList();
        }
        if (alive.Count == 0) return null;

        if (!string.IsNullOrWhiteSpace(req.StickyKey))
        {
            var idx = (uint)req.StickyKey!.GetHashCode() % (uint)alive.Count;
            return alive[(int)idx];
        }

        return opts.RoutingStrategy?.ToLowerInvariant() switch
        {
            "round-robin" => alive[_state.NextRoundRobin(alive.Count)],
            _ => PickWeighted(alive),
        };
    }

    private static SidecarInstanceConfig PickWeighted(List<SidecarInstanceConfig> alive)
    {
        var totalWeight = alive.Sum(s => Math.Max(1, s.Weight));
        var pick = Random.Shared.Next(0, totalWeight);
        var acc = 0;
        foreach (var s in alive)
        {
            acc += Math.Max(1, s.Weight);
            if (pick < acc) return s;
        }
        return alive[^1];
    }

    private static string ResolveToken(SidecarInstanceConfig instance)
    {
        if (!string.IsNullOrWhiteSpace(instance.Token)) return instance.Token;
        if (!string.IsNullOrWhiteSpace(instance.TokenEnvVar))
        {
            var v = Environment.GetEnvironmentVariable(instance.TokenEnvVar);
            if (!string.IsNullOrWhiteSpace(v)) return v;
        }
        return string.Empty;
    }

    private static StringContent SerializeBody(SidecarRunRequest req)
    {
        // 显式 snake_case → 与 Python sidecar schemas.py 中的 alias 对齐
        var dto = new
        {
            runId = req.RunId,
            model = req.Model,
            systemPrompt = req.SystemPrompt,
            messages = req.Messages.Select(m => new { role = m.Role, content = m.Content }),
            tools = req.Tools.Select(t => new
            {
                name = t.Name,
                description = t.Description,
                input_schema = t.InputSchema,
            }),
            maxTokens = req.MaxTokens,
            maxTurns = req.MaxTurns,
            timeoutSeconds = req.TimeoutSeconds,
            callbackBaseUrl = req.CallbackBaseUrl,
            agentApiKey = req.AgentApiKey,
            appCallerCode = req.AppCallerCode,
        };
        var json = JsonSerializer.Serialize(dto, JsonOpts);
        return new StringContent(json, Encoding.UTF8, "application/json");
    }

    private static async IAsyncEnumerable<SidecarEvent> ParseSseAsync(
        Stream stream,
        string sidecarName,
        [EnumeratorCancellation] CancellationToken ct)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8);
        string? eventName = null;
        var dataBuf = new StringBuilder();

        while (!ct.IsCancellationRequested)
        {
            string? line;
            var cancelled = false;
            try { line = await reader.ReadLineAsync(ct); }
            catch (OperationCanceledException) { line = null; cancelled = true; }

            if (cancelled || line == null) yield break;

            if (line.Length == 0)
            {
                if (dataBuf.Length > 0)
                {
                    var ev = ParseEvent(eventName, dataBuf.ToString(), sidecarName);
                    if (ev != null) yield return ev;
                }
                eventName = null;
                dataBuf.Clear();
                continue;
            }

            if (line.StartsWith(":", StringComparison.Ordinal))
            {
                // SSE 注释（含 sidecar 的 keepalive / idle）
                yield return new SidecarEvent
                {
                    Type = SidecarEventType.Keepalive,
                    SidecarName = sidecarName,
                };
                continue;
            }

            if (line.StartsWith("event:", StringComparison.Ordinal))
            {
                eventName = line[6..].Trim();
            }
            else if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                if (dataBuf.Length > 0) dataBuf.Append('\n');
                dataBuf.Append(line[5..].TrimStart());
            }
        }
    }

    private static SidecarEvent? ParseEvent(string? eventName, string data, string sidecarName)
    {
        var type = MapType(eventName);
        if (type == SidecarEventType.Unknown && string.IsNullOrWhiteSpace(eventName))
            return null;

        try
        {
            using var doc = JsonDocument.Parse(data);
            var root = doc.RootElement;

            return new SidecarEvent
            {
                Type = type,
                RawType = eventName,
                Text = TryStr(root, "text"),
                ToolName = TryStr(root, "tool_name"),
                ToolUseId = TryStr(root, "tool_use_id"),
                ToolInput = TryClone(root, "tool_input"),
                Content = TryStr(root, "content"),
                FinalText = TryStr(root, "final_text"),
                InputTokens = TryLong(root, "input_tokens"),
                OutputTokens = TryLong(root, "output_tokens"),
                ErrorCode = TryStr(root, "error_code"),
                Message = TryStr(root, "message"),
                Turn = TryInt(root, "turn"),
                SidecarName = sidecarName,
            };
        }
        catch (JsonException)
        {
            return new SidecarEvent
            {
                Type = SidecarEventType.Unknown,
                RawType = eventName,
                Message = data,
                SidecarName = sidecarName,
            };
        }
    }

    private static SidecarEventType MapType(string? eventName) => eventName switch
    {
        "text_delta" => SidecarEventType.TextDelta,
        "tool_use" => SidecarEventType.ToolUse,
        "tool_result" => SidecarEventType.ToolResult,
        "usage" => SidecarEventType.Usage,
        "done" => SidecarEventType.Done,
        "error" => SidecarEventType.Error,
        _ => SidecarEventType.Unknown,
    };

    private static string? TryStr(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : v.ValueKind == JsonValueKind.Number ? v.ToString() : null;

    private static long? TryLong(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
            ? v.GetInt64()
            : null;

    private static int? TryInt(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
            ? v.GetInt32()
            : null;

    private static JsonElement? TryClone(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) ? v.Clone() : null;

    private static string CombineUrl(string baseUrl, string path)
    {
        var b = baseUrl.TrimEnd('/');
        var p = path.StartsWith("/") ? path : "/" + path;
        return b + p;
    }

    private static async Task<string> SafeReadString(HttpResponseMessage resp, CancellationToken ct)
    {
        try
        {
            var text = await resp.Content.ReadAsStringAsync(ct);
            return text.Length > 500 ? text[..500] : text;
        }
        catch { return string.Empty; }
    }
}
