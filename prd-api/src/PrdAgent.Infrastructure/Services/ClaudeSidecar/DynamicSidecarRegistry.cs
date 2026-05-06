using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.ClaudeSidecar;

/// <summary>
/// IDynamicSidecarRegistry 默认实现。
///
/// 数据流：
///   1. GetCurrent() 永远立即返回当前快照（静态 + 上次成功的动态）
///   2. RefreshAsync() 拉 CDS API：
///        GET {cds}/api/cds-system/remote-hosts          → 主机列表
///        GET {cds}/api/cds-system/remote-hosts/{id}/instance → 每台当前实例
///      仅把"有实例 + 主机 enabled"的转成 DynamicSidecarInstance，覆盖动态部分
///   3. 整个 CDS Discovery 失败 → 保留上次的动态快照 + 记录 LastRefreshError，
///      路由器仍用静态 + 旧动态，不致于全盘失能
///
/// CdsSidecarSyncService（HostedService）按 RefreshIntervalSeconds 周期调用本服务。
/// </summary>
public sealed class DynamicSidecarRegistry : IDynamicSidecarRegistry
{
    public const string HttpClientName = "claude-sidecar-cds-discovery";

    private readonly IOptionsMonitor<ClaudeSidecarOptions> _options;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<DynamicSidecarRegistry> _logger;

    private readonly object _lock = new();
    private List<DynamicSidecarInstance> _dynamic = new();
    private DateTime? _lastRefreshedAt;
    private string? _lastRefreshError;

    public DynamicSidecarRegistry(
        IOptionsMonitor<ClaudeSidecarOptions> options,
        IHttpClientFactory httpFactory,
        ILogger<DynamicSidecarRegistry> logger)
    {
        _options = options;
        _httpFactory = httpFactory;
        _logger = logger;
    }

    public DateTime? LastRefreshedAt
    {
        get { lock (_lock) return _lastRefreshedAt; }
    }

    public string? LastRefreshError
    {
        get { lock (_lock) return _lastRefreshError; }
    }

    public IReadOnlyList<DynamicSidecarInstance> GetCurrent()
    {
        var staticOnes = MapStatic(_options.CurrentValue);
        List<DynamicSidecarInstance> dynamicSnapshot;
        lock (_lock) dynamicSnapshot = _dynamic;
        var merged = new List<DynamicSidecarInstance>(staticOnes.Count + dynamicSnapshot.Count);
        merged.AddRange(staticOnes);
        merged.AddRange(dynamicSnapshot);
        return merged;
    }

    public async Task RefreshAsync(CancellationToken ct)
    {
        var opts = _options.CurrentValue;
        if (!opts.CdsDiscovery.Enabled || string.IsNullOrWhiteSpace(opts.CdsDiscovery.BaseUrl))
        {
            // 未启用 CDS Discovery：清空动态快照（避免上一轮残留），不视为错误
            lock (_lock)
            {
                _dynamic = new List<DynamicSidecarInstance>();
                _lastRefreshedAt = DateTime.UtcNow;
                _lastRefreshError = null;
            }
            return;
        }

        try
        {
            var http = _httpFactory.CreateClient(HttpClientName);
            http.Timeout = TimeSpan.FromSeconds(Math.Max(2, opts.CdsDiscovery.RequestTimeoutSeconds));
            ApplyCdsAuth(http, opts.CdsDiscovery);

            var baseUrl = opts.CdsDiscovery.BaseUrl.TrimEnd('/');
            var listResp = await http.GetFromJsonAsync<HostListEnvelope>(
                $"{baseUrl}/api/cds-system/remote-hosts", ct);
            if (listResp?.Hosts == null)
            {
                throw new InvalidOperationException("CDS /remote-hosts returned empty body");
            }

            var newDynamic = new List<DynamicSidecarInstance>();
            foreach (var host in listResp.Hosts)
            {
                if (host.Id == null) continue;
                if (host.IsEnabled == false) continue;

                InstanceEnvelope? instResp;
                try
                {
                    instResp = await http.GetFromJsonAsync<InstanceEnvelope>(
                        $"{baseUrl}/api/cds-system/remote-hosts/{host.Id}/instance", ct);
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "[CdsDiscovery] instance probe failed host={Id}", host.Id);
                    continue;
                }
                if (instResp?.Instance == null) continue;

                var inst = instResp.Instance;
                if (string.IsNullOrWhiteSpace(inst.Host) || inst.Port == null) continue;

                var token = !string.IsNullOrWhiteSpace(opts.CdsDiscovery.SharedSidecarToken)
                    ? opts.CdsDiscovery.SharedSidecarToken
                    : opts.DefaultSidecarToken;

                newDynamic.Add(new DynamicSidecarInstance
                {
                    Name = $"cds:{host.Id}",
                    BaseUrl = $"http://{inst.Host}:{inst.Port}",
                    Token = token,
                    Weight = 1,
                    Tags = host.Tags ?? Array.Empty<string>(),
                    Source = "cds",
                });
            }

            lock (_lock)
            {
                _dynamic = newDynamic;
                _lastRefreshedAt = DateTime.UtcNow;
                _lastRefreshError = null;
            }
            _logger.LogInformation(
                "[CdsDiscovery] refreshed {N} sidecar instance(s) from CDS", newDynamic.Count);
        }
        catch (Exception ex)
        {
            lock (_lock)
            {
                _lastRefreshedAt = DateTime.UtcNow;
                _lastRefreshError = ex.Message;
            }
            _logger.LogWarning(ex, "[CdsDiscovery] refresh failed; keeping previous snapshot");
        }
    }

    private static IReadOnlyList<DynamicSidecarInstance> MapStatic(ClaudeSidecarOptions opts)
    {
        var list = new List<DynamicSidecarInstance>();
        foreach (var s in opts.Sidecars)
        {
            var token = !string.IsNullOrWhiteSpace(s.Token)
                ? s.Token
                : !string.IsNullOrWhiteSpace(s.TokenEnvVar)
                    ? Environment.GetEnvironmentVariable(s.TokenEnvVar) ?? string.Empty
                    : string.Empty;
            list.Add(new DynamicSidecarInstance
            {
                Name = s.Name,
                BaseUrl = s.BaseUrl,
                Token = token,
                Weight = s.Weight,
                Tags = s.Tags ?? new List<string>(),
                Source = "static",
            });
        }
        return list;
    }

    private static void ApplyCdsAuth(HttpClient http, CdsDiscoveryConfig cfg)
    {
        if (string.IsNullOrWhiteSpace(cfg.CdsAuthHeader)) return;
        // 支持两种格式：完整 "Authorization: Bearer xxx" / 单独 "Bearer xxx"
        var raw = cfg.CdsAuthHeader.Trim();
        if (raw.StartsWith("Authorization:", StringComparison.OrdinalIgnoreCase))
            raw = raw.Substring("Authorization:".Length).Trim();
        if (raw.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", raw["Bearer ".Length..]);
        }
        else
        {
            http.DefaultRequestHeaders.TryAddWithoutValidation("Authorization", raw);
        }
    }

    // ── DTOs ── 与 cds/src/routes/remote-hosts.ts 的 JSON 形状对齐 ──

    private sealed class HostListEnvelope
    {
        public List<HostDto>? Hosts { get; set; }
    }

    private sealed class HostDto
    {
        public string? Id { get; set; }
        public string? Name { get; set; }
        public List<string>? Tags { get; set; }
        public bool? IsEnabled { get; set; }
    }

    private sealed class InstanceEnvelope
    {
        public InstanceDto? Instance { get; set; }
    }

    private sealed class InstanceDto
    {
        public string? Host { get; set; }
        public int? Port { get; set; }
        public bool? Healthy { get; set; }
        public string? Version { get; set; }
    }
}
