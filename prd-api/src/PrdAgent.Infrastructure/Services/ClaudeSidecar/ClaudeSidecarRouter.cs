using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Services.AgentTools;

namespace PrdAgent.Infrastructure.Services.ClaudeSidecar;

/// <summary>
/// 多实例 sidecar 路由 + SSE 流式调用。
/// 跨服务器/sandbox：仅由 BaseUrl 与 Tags 区分，业务无感知。
/// 健康状态由 ClaudeSidecarHealthChecker（HostedService）周期写入 _state。
/// </summary>
public sealed class ClaudeSidecarRouter : IClaudeSidecarRouter
{
    public const string HttpClientName = "claude-sidecar";
    internal const string PairedCdsSource = "cds-pairing";

    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly IHttpClientFactory _httpFactory;
    private readonly IOptionsMonitor<ClaudeSidecarOptions> _options;
    private readonly ILogger<ClaudeSidecarRouter> _logger;
    private readonly InstanceStateRegistry _state;
    private readonly IDynamicSidecarRegistry _registry;
    private readonly IConfiguration _configuration;
    private readonly IHttpContextAccessor _httpContextAccessor;

    public ClaudeSidecarRouter(
        IHttpClientFactory httpFactory,
        IOptionsMonitor<ClaudeSidecarOptions> options,
        InstanceStateRegistry state,
        IDynamicSidecarRegistry registry,
        IConfiguration configuration,
        IHttpContextAccessor httpContextAccessor,
        ILogger<ClaudeSidecarRouter> logger)
    {
        _httpFactory = httpFactory;
        _options = options;
        _state = state;
        _registry = registry;
        _configuration = configuration;
        _httpContextAccessor = httpContextAccessor;
        _logger = logger;
    }

    public bool IsConfigured =>
        GetRoutableInstances(_options.CurrentValue).Count > 0;

    public int InstanceCount => _registry.GetCurrent().Count;

    public int HealthyCount => _state.CountHealthy();

    public IReadOnlyList<string> Blockers => BuildPoolBlockers(BuildSnapshotDiagnostics());

    public IReadOnlyList<string> NextActions => BuildPoolNextActions(BuildSnapshotDiagnostics());

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

        // 自动注入 callbackBaseUrl / 反向调用 token：调用方不传时由 options + 实例 token 兜底。
        // 这是"无脑配置"的关键 —— 节点配置只关心 model / prompt / tools，不用管反向回调链路。
        var opts = _options.CurrentValue;
        var effectiveCallbackUrl = ResolveCallbackBaseUrl(request, instance, opts);
        var effectiveCallbackToken = string.IsNullOrWhiteSpace(request.AgentApiKey)
            ? token
            : request.AgentApiKey;

        var http = _httpFactory.CreateClient(HttpClientName);
        http.Timeout = Timeout.InfiniteTimeSpan;

        using var httpReq = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = SerializeBody(request, effectiveCallbackUrl, effectiveCallbackToken),
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

    public async Task<SidecarCancelResult> CancelRunAsync(string runId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(runId))
            return new SidecarCancelResult(false, "run_id_empty");

        var instances = GetRoutableInstances(_options.CurrentValue);
        if (instances.Count == 0)
            return new SidecarCancelResult(false, "sidecar_not_configured");

        var http = _httpFactory.CreateClient(HttpClientName);
        var lastReason = "not found";
        foreach (var instance in instances)
        {
            var token = ResolveToken(instance);
            if (string.IsNullOrWhiteSpace(token))
            {
                lastReason = "sidecar_token_missing";
                continue;
            }

            var url = CombineUrl(instance.BaseUrl, $"/v1/agent/cancel/{Uri.EscapeDataString(runId)}");
            using var httpReq = new HttpRequestMessage(HttpMethod.Post, url);
            httpReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            try
            {
                using var response = await http.SendAsync(httpReq, ct);
                var body = await SafeReadString(response, ct);
                if (response.IsSuccessStatusCode)
                {
                    _state.RecordSuccess(instance.Name);
                    return new SidecarCancelResult(true, null, instance.Name);
                }

                lastReason = string.IsNullOrWhiteSpace(body)
                    ? $"sidecar_http_{(int)response.StatusCode}"
                    : body;
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                _state.RecordFailure(instance.Name);
                lastReason = ex.Message;
            }
        }

        return new SidecarCancelResult(false, lastReason);
    }

    public async Task<SidecarPoolDiagnostics> GetDiagnosticsAsync(CancellationToken ct)
    {
        var instances = GetRoutableInstances(_options.CurrentValue);
        var http = _httpFactory.CreateClient(HttpClientName);
        var results = new List<SidecarInstanceDiagnostics>(instances.Count);

        foreach (var instance in instances)
        {
            var token = ResolveToken(instance);
            var url = CombineUrl(instance.BaseUrl, "/readyz");
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, url);
                using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
                var body = await SafeReadString(resp, ct, maxLength: 8_000);
                var parsed = ParseReadyz(body);
                results.Add(new SidecarInstanceDiagnostics(
                    instance.Name,
                    instance.BaseUrl,
                    instance.Source,
                    instance.Tags,
                    !string.IsNullOrWhiteSpace(token),
                    _state.IsHealthy(instance.Name),
                    (int)resp.StatusCode,
                    parsed.Ready,
                    parsed.AnthropicKey,
                    parsed.ProviderKeyRequiredForReady,
                    parsed.SidecarToken,
                    parsed.AgentAdapter,
                    parsed.AdapterDiagnosticsJson,
                    resp.IsSuccessStatusCode ? null : Truncate(body, 800),
                    parsed.ReadyzBlockers,
                    parsed.ReadyzNextActions,
                    parsed.LoopOwner,
                    parsed.SdkLoopEnabled,
                    parsed.MapRole,
                    parsed.CdsRole,
                    parsed.ClaudeCliPath,
                    parsed.ClaudeCliBundled));
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                results.Add(new SidecarInstanceDiagnostics(
                    instance.Name,
                    instance.BaseUrl,
                    instance.Source,
                    instance.Tags,
                    !string.IsNullOrWhiteSpace(token),
                    _state.IsHealthy(instance.Name),
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    ex.Message));
            }
        }

        return new SidecarPoolDiagnostics(
            IsConfigured,
            InstanceCount,
            HealthyCount,
            results,
            _registry.LastRefreshedAt,
            _registry.LastRefreshError,
            BuildPoolBlockers(results),
            BuildPoolNextActions(results));
    }

    private IReadOnlyList<string> BuildPoolBlockers(IReadOnlyList<SidecarInstanceDiagnostics> instances)
    {
        var blockers = new List<string>();
        if (InstanceCount <= 0)
        {
            blockers.Add("MAP 当前没有发现任何 CDS sidecar runtime 实例");
            if (!string.IsNullOrWhiteSpace(_registry.LastRefreshError))
            {
                blockers.Add(_registry.LastRefreshError);
            }
            return blockers;
        }

        if (HealthyCount <= 0)
        {
            blockers.Add("所有已发现的 sidecar runtime 实例当前都不可用");
        }

        foreach (var instance in instances)
        {
            if (!instance.TokenConfigured)
            {
                blockers.Add($"{instance.Name}: 缺少 sidecar bearer token");
            }
            if (instance.HttpStatus is >= 400)
            {
                blockers.Add($"{instance.Name}: /readyz 返回 HTTP {instance.HttpStatus}");
            }
            if (instance.Ready == false)
            {
                blockers.Add($"{instance.Name}: /readyz ready=false");
            }
            if (instance.ProviderKeyRequiredForReady != false && instance.AnthropicKeyConfigured == false)
            {
                blockers.Add($"{instance.Name}: 缺少 ANTHROPIC_API_KEY");
            }
            if (instance.SidecarTokenConfigured == false)
            {
                blockers.Add($"{instance.Name}: 缺少 SIDECAR_TOKEN");
            }
            foreach (var blocker in instance.ReadyzBlockers ?? Array.Empty<string>())
            {
                blockers.Add($"{instance.Name}: {blocker}");
            }
            foreach (var missing in ReadMissingAdapterDependencies(instance.AdapterDiagnosticsJson))
            {
                blockers.Add($"{instance.Name}: 缺少 {missing}");
            }
            if (!string.IsNullOrWhiteSpace(instance.Error))
            {
                blockers.Add($"{instance.Name}: {instance.Error}");
            }
        }

        return blockers.Distinct(StringComparer.Ordinal).Take(12).ToList();
    }

    private IReadOnlyList<SidecarInstanceDiagnostics> BuildSnapshotDiagnostics()
    {
        return GetRoutableInstances(_options.CurrentValue)
            .Select(instance => new SidecarInstanceDiagnostics(
                instance.Name,
                instance.BaseUrl,
                instance.Source,
                instance.Tags,
                !string.IsNullOrWhiteSpace(ResolveToken(instance)),
                _state.IsHealthy(instance.Name),
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null))
            .ToList();
    }

    private IReadOnlyList<string> BuildPoolNextActions(IReadOnlyList<SidecarInstanceDiagnostics> instances)
    {
        var actions = new List<string>();
        if (InstanceCount <= 0)
        {
            var refreshError = _registry.LastRefreshError ?? string.Empty;
            if (refreshError.Contains("paired-empty-endpoints", StringComparison.OrdinalIgnoreCase)
                || refreshError.Contains("empty_instances", StringComparison.OrdinalIgnoreCase))
            {
                actions.Add("当前 CDS 授权可用但实例列表为空：优先更新共享 CDS 控制面的 /api/projects/{id}/instances，使其暴露 running 的 branch-service sidecar 实例");
                if (!refreshError.Contains("discovery(", StringComparison.OrdinalIgnoreCase))
                {
                    actions.Add("当前 CDS 控制面未返回 instances discovery 摘要，说明共享 CDS 本体仍是旧版本或尚未完成发布");
                }
                if (HasPositiveDiscoveryMetric(refreshError, "skippedBranchServices")
                    && !HasPositiveDiscoveryMetric(refreshError, "runtimeBranchServices"))
                {
                    actions.Add("CDS 发现到 running 分支服务但全部被 runtime 过滤跳过：确认 sidecar runtime profile/service 名称包含 api、sidecar、runtime、worker 或 agent，且不要命名为 admin/web/ui");
                }
                else if (!HasPositiveDiscoveryMetric(refreshError, "runningBranchServices"))
                {
                    actions.Add("确认 shared sidecar pool 分支服务正在运行；当前 discovery 未看到 running branch service");
                }
                else
                {
                    actions.Add("确认 shared sidecar pool 分支服务正在运行，并且服务标签/来源允许 MAP 作为 cds-sidecar 发现");
                }
            }
            else
            {
                actions.Add("确认共享 CDS 控制面的 /api/projects/{id}/instances 已包含 branch-service sidecar 实例发现修复");
                actions.Add("确认 shared sidecar pool 正在运行，并且实例标签/来源允许当前 MAP 发现");
            }

            if (refreshError.Contains("invalid_long_token", StringComparison.OrdinalIgnoreCase)
                || HasPositiveDiscoveryMetric(refreshError, "tokenFailures")
                || refreshError.Contains("DataProtection", StringComparison.OrdinalIgnoreCase))
            {
                actions.Add("在 MAP 基础设施设置中重新完成 CDS 长期授权，清理旧 DataProtection key 或 invalid_long_token 失效连接");
            }
        }
        else if (HealthyCount <= 0)
        {
            foreach (var action in instances.SelectMany(x => x.ReadyzNextActions ?? Array.Empty<string>()))
            {
                actions.Add(action);
            }
            var providerKeyRequired = instances.Any(x => x.ProviderKeyRequiredForReady != false);
            actions.Add(providerKeyRequired
                ? "进入 sidecar 容器检查 /readyz，优先修复 ANTHROPIC_API_KEY、SIDECAR_TOKEN 和 claude-agent-sdk"
                : "进入 sidecar 容器检查 /readyz，优先修复 SIDECAR_TOKEN 和 claude-agent-sdk；模型 provider key 可由 MAP runtime profile 按请求下发");
            actions.Add("确认 SIDECAR_AGENT_ADAPTER=claude-agent-sdk 时，AGENT_WORKSPACE_ROOT 存在且可读写");
            actions.Add("修复后刷新 runtime-status，再启动 CDS Agent 会话");
        }

        if (instances.Any(x => x.AdapterDiagnosticsJson?.Contains("claude-agent-sdk", StringComparison.OrdinalIgnoreCase) == true))
        {
            actions.Add("官方 SDK 模式下保持 MAP/CDS 只做控制面，工具执行和 turn loop 继续走 claude-agent-sdk");
        }

        return actions.Distinct(StringComparer.Ordinal).Take(8).ToList();
    }

    private static bool HasPositiveDiscoveryMetric(string value, string metric)
    {
        var index = value.IndexOf(metric + "=", StringComparison.OrdinalIgnoreCase);
        if (index < 0) return false;
        var start = index + metric.Length + 1;
        var end = start;
        while (end < value.Length && char.IsDigit(value[end])) end += 1;
        return end > start
            && int.TryParse(value[start..end], out var count)
            && count > 0;
    }

    private static IEnumerable<string> ReadMissingAdapterDependencies(string? diagnosticsJson)
    {
        if (string.IsNullOrWhiteSpace(diagnosticsJson)) yield break;
        JsonDocument? doc = null;
        try
        {
            doc = JsonDocument.Parse(diagnosticsJson);
            if (!doc.RootElement.TryGetProperty("missing", out var missing) || missing.ValueKind != JsonValueKind.Array)
            {
                yield break;
            }

            foreach (var item in missing.EnumerateArray())
            {
                var value = item.GetString();
                if (!string.IsNullOrWhiteSpace(value))
                {
                    yield return value!;
                }
            }
        }
        finally
        {
            doc?.Dispose();
        }
    }

    private static (bool? Ready, bool? AnthropicKey, bool? ProviderKeyRequiredForReady, bool? SidecarToken, string? AgentAdapter, string? AdapterDiagnosticsJson, IReadOnlyList<string>? ReadyzBlockers, IReadOnlyList<string>? ReadyzNextActions, string? LoopOwner, bool? SdkLoopEnabled, string? MapRole, string? CdsRole, string? ClaudeCliPath, bool? ClaudeCliBundled) ParseReadyz(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
            return (null, null, null, null, null, null, null, null, null, null, null, null, null, null);

        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            bool? ready = root.TryGetProperty("ready", out var readyElement)
                && (readyElement.ValueKind == JsonValueKind.True || readyElement.ValueKind == JsonValueKind.False)
                ? readyElement.GetBoolean()
                : null;
            bool? anthropicKey = root.TryGetProperty("anthropicKey", out var anthropicKeyElement)
                && (anthropicKeyElement.ValueKind == JsonValueKind.True || anthropicKeyElement.ValueKind == JsonValueKind.False)
                ? anthropicKeyElement.GetBoolean()
                : null;
            bool? providerKeyRequiredForReady = root.TryGetProperty("providerKeyRequiredForReady", out var providerKeyElement)
                && (providerKeyElement.ValueKind == JsonValueKind.True || providerKeyElement.ValueKind == JsonValueKind.False)
                ? providerKeyElement.GetBoolean()
                : null;
            bool? sidecarToken = root.TryGetProperty("sidecarToken", out var sidecarTokenElement)
                && (sidecarTokenElement.ValueKind == JsonValueKind.True || sidecarTokenElement.ValueKind == JsonValueKind.False)
                ? sidecarTokenElement.GetBoolean()
                : null;
            string? adapter = root.TryGetProperty("agentAdapter", out var adapterElement)
                && adapterElement.ValueKind == JsonValueKind.String
                ? adapterElement.GetString()
                : null;
            string? adapterDiagnostics = root.TryGetProperty("adapterDiagnostics", out var diagElement)
                ? diagElement.GetRawText()
                : null;
            string? loopOwner = TryReadString(diagElement, "loopOwner");
            bool? sdkLoopEnabled = TryReadBool(diagElement, "sdkLoopEnabled");
            string? mapRole = TryReadString(diagElement, "mapRole");
            string? cdsRole = TryReadString(diagElement, "cdsRole");
            string? claudeCliPath = TryReadString(diagElement, "claudeCliPath");
            bool? claudeCliBundled = TryReadBool(diagElement, "claudeCliBundled");
            var blockers = ReadStringArray(root, "blockers");
            var nextActions = ReadStringArray(root, "nextActions");
            return (ready, anthropicKey, providerKeyRequiredForReady, sidecarToken, adapter, adapterDiagnostics, blockers, nextActions, loopOwner, sdkLoopEnabled, mapRole, cdsRole, claudeCliPath, claudeCliBundled);
        }
        catch (JsonException)
        {
            return (null, null, null, null, null, null, null, null, null, null, null, null, null, null);
        }
    }

    private static string? TryReadString(JsonElement value, string name)
    {
        return value.ValueKind == JsonValueKind.Object
            && value.TryGetProperty(name, out var item)
            && item.ValueKind == JsonValueKind.String
            ? item.GetString()
            : null;
    }

    private static bool? TryReadBool(JsonElement value, string name)
    {
        return value.ValueKind == JsonValueKind.Object
            && value.TryGetProperty(name, out var item)
            && (item.ValueKind == JsonValueKind.True || item.ValueKind == JsonValueKind.False)
            ? item.GetBoolean()
            : null;
    }

    private static IReadOnlyList<string>? ReadStringArray(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array)
            return null;

        var items = value.EnumerateArray()
            .Where(x => x.ValueKind == JsonValueKind.String)
            .Select(x => x.GetString())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x!)
            .Take(12)
            .ToList();

        return items.Count > 0 ? items : Array.Empty<string>();
    }

    private static string Truncate(string value, int max)
    {
        if (string.IsNullOrEmpty(value) || value.Length <= max) return value;
        return value[..max] + "...";
    }

    private async Task<DispatchResult> DispatchAsync(
        HttpClient http,
        HttpRequestMessage httpReq,
        DynamicSidecarInstance instance,
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

    private DynamicSidecarInstance? PickInstance(SidecarRunRequest req)
    {
        var opts = _options.CurrentValue;
        IEnumerable<DynamicSidecarInstance> candidates = GetRoutableInstances(opts);

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

    private IReadOnlyList<DynamicSidecarInstance> GetRoutableInstances(ClaudeSidecarOptions opts)
    {
        var current = _registry.GetCurrent();
        if (opts.Enabled) return current;

        // A paired CDS shared-service sidecar is an external execution pool:
        // it holds its own Anthropic credentials, so MAP must be able to route
        // to it even when the local zero-config sidecar switch is off.
        return current
            .Where(s => string.Equals(s.Source, PairedCdsSource, StringComparison.OrdinalIgnoreCase))
            .ToList();
    }

    private static DynamicSidecarInstance PickWeighted(List<DynamicSidecarInstance> alive)
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

    private static string ResolveToken(DynamicSidecarInstance instance)
    {
        return instance.Token ?? string.Empty;
    }

    private string ResolveCallbackBaseUrl(
        SidecarRunRequest request,
        DynamicSidecarInstance instance,
        ClaudeSidecarOptions opts)
    {
        if (!string.IsNullOrWhiteSpace(request.CallbackBaseUrl))
            return request.CallbackBaseUrl.TrimEnd('/');

        if (string.Equals(instance.Source, PairedCdsSource, StringComparison.OrdinalIgnoreCase))
        {
            var publicBaseUrl = ResolvePublicMapBaseUrl();
            if (!string.IsNullOrWhiteSpace(publicBaseUrl))
                return publicBaseUrl;
        }

        return opts.CallbackBaseUrl.TrimEnd('/');
    }

    private string? ResolvePublicMapBaseUrl()
    {
        var configured = _configuration["ServerUrl"];
        if (!string.IsNullOrWhiteSpace(configured))
            return configured.TrimEnd('/');

        configured = _configuration["App:FrontendBaseUrl"];
        if (!string.IsNullOrWhiteSpace(configured))
            return configured.TrimEnd('/');

        var derivedPreviewUrl = ResolveDerivedPreviewBaseUrl();
        if (!string.IsNullOrWhiteSpace(derivedPreviewUrl))
            return derivedPreviewUrl;

        var req = _httpContextAccessor.HttpContext?.Request;
        if (req == null) return null;

        var clientBaseUrl = req.Headers["X-Client-Base-Url"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(clientBaseUrl))
            return clientBaseUrl.TrimEnd('/');

        var forwardedHost = req.Headers["X-Forwarded-Host"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(forwardedHost))
        {
            var forwardedProto = req.Headers["X-Forwarded-Proto"].FirstOrDefault();
            var scheme = string.IsNullOrWhiteSpace(forwardedProto) ? "https" : forwardedProto.Split(',')[0].Trim();
            return $"{scheme}://{forwardedHost.Split(',')[0].Trim()}".TrimEnd('/');
        }

        var origin = req.Headers.Origin.FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(origin))
            return origin.TrimEnd('/');

        if (req.Host.HasValue)
        {
            var scheme = string.IsNullOrWhiteSpace(req.Scheme) ? "https" : req.Scheme;
            return $"{scheme}://{req.Host.Value}".TrimEnd('/');
        }

        return null;
    }

    private string? ResolveDerivedPreviewBaseUrl()
    {
        var workspace = AgentWorkspace.Resolve(_configuration);
        var branch = FirstConfigValue(
                "MAP_PREVIEW_BRANCH",
                "VITE_GIT_BRANCH",
                "AGENT_WORKSPACE_GIT_REF",
                "GIT_BRANCH",
                "AgentWorkspace:GitRef")
            ?? workspace.GitRef;
        var project = FirstConfigValue(
            "MAP_PROJECT_SLUG",
            "AGENT_WORKSPACE_PROJECT_SLUG",
            "AgentWorkspace:ProjectSlug");
        if (string.IsNullOrWhiteSpace(project))
        {
            var repo = FirstConfigValue(
                    "AGENT_WORKSPACE_GITHUB_REPOSITORY",
                    "GITHUB_REPOSITORY",
                    "AgentWorkspace:GitHubRepository")
                ?? workspace.GitHubRepository;
            if (!string.IsNullOrWhiteSpace(repo))
                project = repo.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
        }

        var domain = FirstConfigValue("MAP_PREVIEW_DOMAIN", "CDS_PREVIEW_DOMAIN", "PREVIEW_DOMAIN", "PreviewDomain");
        if (string.IsNullOrWhiteSpace(domain))
            domain = "miduo.org";

        var slug = ComputePreviewSlug(branch, project);
        if (string.IsNullOrWhiteSpace(slug) || string.IsNullOrWhiteSpace(domain))
            return null;

        return $"https://{slug}.{domain.Trim().Trim('.')}";
    }

    private string? FirstConfigValue(params string[] keys)
    {
        foreach (var key in keys)
        {
            var value = _configuration[key];
            if (!string.IsNullOrWhiteSpace(value))
                return value.Trim();
        }
        return null;
    }

    private static string? ComputePreviewSlug(string? branch, string? project)
    {
        var projectSlug = Slugify(project);
        var branchValue = (branch ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(branchValue) || string.IsNullOrWhiteSpace(projectSlug))
            return null;

        var slash = branchValue.IndexOf('/');
        if (slash > 0 && slash < branchValue.Length - 1)
        {
            var prefix = Slugify(branchValue[..slash]);
            var tail = Slugify(branchValue[(slash + 1)..].Replace('/', '-'));
            if (!string.IsNullOrWhiteSpace(prefix) && !string.IsNullOrWhiteSpace(tail))
                return $"{tail}-{prefix}-{projectSlug}";
        }

        var branchSlug = Slugify(branchValue.Replace('/', '-'));
        return string.IsNullOrWhiteSpace(branchSlug) ? null : $"{branchSlug}-{projectSlug}";
    }

    private static string Slugify(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;

        var sb = new StringBuilder(value.Length);
        var lastDash = false;
        foreach (var ch in value.Trim().ToLowerInvariant())
        {
            var ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
            if (ok)
            {
                sb.Append(ch);
                lastDash = false;
                continue;
            }

            if (ch == '-' || ch == '_' || ch == '/' || ch == '.')
            {
                if (!lastDash && sb.Length > 0)
                {
                    sb.Append('-');
                    lastDash = true;
                }
                continue;
            }

            if (!lastDash && sb.Length > 0)
            {
                sb.Append('-');
                lastDash = true;
            }
        }

        return sb.ToString().Trim('-');
    }

    private static StringContent SerializeBody(
        SidecarRunRequest req, string? callbackBaseUrl, string? callbackToken)
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
            callbackBaseUrl,
            // 字段名沿用历史 agentApiKey；运行时含义见 sidecar/app/tool_bridge.py 注释
            agentApiKey = callbackToken,
            appCallerCode = req.AppCallerCode,
            // 上游切换：profile 优先，其次 baseUrl + apiKey，都没有则走 sidecar env 默认
            profile = string.IsNullOrWhiteSpace(req.Profile) ? null : req.Profile,
            baseUrl = string.IsNullOrWhiteSpace(req.BaseUrl) ? null : req.BaseUrl,
            apiKey = string.IsNullOrWhiteSpace(req.ApiKey) ? null : req.ApiKey,
            protocol = string.IsNullOrWhiteSpace(req.Protocol) ? null : req.Protocol,
            runtimeAdapter = string.IsNullOrWhiteSpace(req.RuntimeAdapter) ? null : req.RuntimeAdapter,
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
                Content = TryStrOrJson(root, "content"),
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
        "runtime_init" => SidecarEventType.RuntimeInit,
        "done" => SidecarEventType.Done,
        "error" => SidecarEventType.Error,
        _ => SidecarEventType.Unknown,
    };

    private static string? TryStr(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : v.ValueKind == JsonValueKind.Number ? v.ToString() : null;

    private static string? TryStrOrJson(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null)
            return null;
        return v.ValueKind == JsonValueKind.String ? v.GetString() : v.GetRawText();
    }

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

    private static async Task<string> SafeReadString(HttpResponseMessage resp, CancellationToken ct, int maxLength = 500)
    {
        try
        {
            var text = await resp.Content.ReadAsStringAsync(ct);
            return text.Length > maxLength ? text[..maxLength] : text;
        }
        catch { return string.Empty; }
    }
}
