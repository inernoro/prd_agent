using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
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
///        a) 已配对 infra_connections：
///           GET {partnerBaseUrl}{instanceDiscoveryUrl}
///        b) 兼容旧配置 CdsDiscovery：
///           GET {cds}/api/cds-system/remote-hosts
///           GET {cds}/api/cds-system/remote-hosts/{id}/instance
///      仅把"有实例 + 主机 enabled"的转成 DynamicSidecarInstance，覆盖动态部分。
///   3. 所有 Discovery 均失败 → 保留上次的动态快照 + 记录 LastRefreshError，
///      路由器仍用静态 + 旧动态，不致于全盘失能
///
/// CdsSidecarSyncService（HostedService）按 RefreshIntervalSeconds 周期调用本服务。
/// </summary>
public sealed class DynamicSidecarRegistry : IDynamicSidecarRegistry
{
    public const string HttpClientName = "claude-sidecar-cds-discovery";

    private readonly IOptionsMonitor<ClaudeSidecarOptions> _options;
    private readonly IHttpClientFactory _httpFactory;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<DynamicSidecarRegistry> _logger;

    private readonly object _lock = new();
    private List<DynamicSidecarInstance> _dynamic = new();
    private DateTime? _lastRefreshedAt;
    private string? _lastRefreshError;

    public DynamicSidecarRegistry(
        IOptionsMonitor<ClaudeSidecarOptions> options,
        IHttpClientFactory httpFactory,
        IServiceScopeFactory scopeFactory,
        ILogger<DynamicSidecarRegistry> logger)
    {
        _options = options;
        _httpFactory = httpFactory;
        _scopeFactory = scopeFactory;
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
        var next = new List<DynamicSidecarInstance>();
        var errors = new List<string>();
        var notes = new List<string>();

        if (opts.CdsDiscovery.EnablePairedInfraConnections)
        {
            try
            {
                next.AddRange(await DiscoverPairedConnectionsAsync(opts, notes, ct));
            }
            catch (Exception ex)
            {
                errors.Add($"paired-connections: {ex.Message}");
                _logger.LogWarning(ex, "[CdsDiscovery] paired infra connection refresh failed");
            }
        }
        else
        {
            notes.Add("paired-connections disabled");
        }

        if (opts.CdsDiscovery.Enabled && !string.IsNullOrWhiteSpace(opts.CdsDiscovery.BaseUrl))
        {
            try
            {
                next.AddRange(await DiscoverConfiguredCdsAsync(opts, notes, ct));
            }
            catch (Exception ex)
            {
                errors.Add($"configured-cds: {ex.Message}");
                _logger.LogWarning(ex, "[CdsDiscovery] configured CDS refresh failed");
            }
        }
        else
        {
            notes.Add("configured-cds disabled");
        }

        if (errors.Count > 0 && next.Count == 0)
        {
            lock (_lock)
            {
                _lastRefreshedAt = DateTime.UtcNow;
                _lastRefreshError = string.Join("; ", errors.Concat(notes));
            }
            _logger.LogWarning("[CdsDiscovery] refresh failed; keeping previous snapshot: {Error}", string.Join("; ", errors));
            return;
        }

        var zeroInstanceReason = next.Count == 0 && notes.Count > 0
            ? string.Join("; ", notes)
            : null;
        lock (_lock)
        {
            _dynamic = next;
            _lastRefreshedAt = DateTime.UtcNow;
            _lastRefreshError = errors.Count == 0
                ? zeroInstanceReason
                : string.Join("; ", errors.Concat(notes));
        }
        if (next.Count == 0)
        {
            _logger.LogWarning(
                "[CdsDiscovery] refreshed 0 sidecar instance(s) from CDS; reason={Reason}",
                zeroInstanceReason ?? "no discovery source returned instances");
        }
        else
        {
            _logger.LogInformation(
                "[CdsDiscovery] refreshed {N} sidecar instance(s) from CDS", next.Count);
        }
    }

    private async Task<IReadOnlyList<DynamicSidecarInstance>> DiscoverConfiguredCdsAsync(
        ClaudeSidecarOptions opts,
        List<string> notes,
        CancellationToken ct)
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

        var discovered = new List<DynamicSidecarInstance>();
        var enabledHosts = 0;
        var hostsWithInstance = 0;
        foreach (var host in listResp.Hosts)
        {
            if (host.Id == null) continue;
            if (host.IsEnabled == false) continue;
            enabledHosts += 1;

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
            hostsWithInstance += 1;

            discovered.Add(ToDynamicInstance(
                name: $"cds:{host.Id}",
                host: inst.Host,
                port: inst.Port.Value,
                token: ResolveSharedSidecarToken(opts),
                tags: host.Tags ?? inst.Tags ?? new List<string>(),
                source: "cds"));
        }
        if (discovered.Count == 0)
        {
            notes.Add($"configured-cds hosts={listResp.Hosts.Count} enabled={enabledHosts} withInstance={hostsWithInstance}");
        }

        return discovered;
    }

    private async Task<IReadOnlyList<DynamicSidecarInstance>> DiscoverPairedConnectionsAsync(
        ClaudeSidecarOptions opts,
        List<string> notes,
        CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var service = scope.ServiceProvider.GetService<IInfraConnectionService>();
        if (service == null) return Array.Empty<DynamicSidecarInstance>();

        var connections = await service.ListAsync(ct);
        var activeCds = connections
            .Where(c => string.Equals(c.Partner, "cds", StringComparison.OrdinalIgnoreCase))
            .Where(c => string.Equals(c.Status, "active", StringComparison.OrdinalIgnoreCase))
            .Where(c => !string.IsNullOrWhiteSpace(c.PartnerBaseUrl))
            .Where(c => !string.IsNullOrWhiteSpace(c.InstanceDiscoveryUrl))
            .ToList();
        if (activeCds.Count == 0)
        {
            notes.Add($"paired-connections total={connections.Count} activeCds=0");
            return Array.Empty<DynamicSidecarInstance>();
        }

        var discovered = new List<DynamicSidecarInstance>();
        var usableConnections = 0;
        var endpointsWithInstances = 0;
        var emptyEndpoints = 0;
        var endpointFailures = 0;
        var encryptedTokenFailures = 0;
        var endpointFailureDetails = new List<string>();
        var emptyEndpointDetails = new List<string>();
        foreach (var conn in activeCds)
        {
            var longToken = await service.TryUnprotectLongTokenAsync(conn.Id, ct, revokeOnFailure: true);
            if (string.IsNullOrWhiteSpace(longToken))
            {
                encryptedTokenFailures += 1;
                continue;
            }
            usableConnections += 1;

            var http = _httpFactory.CreateClient(HttpClientName);
            http.Timeout = TimeSpan.FromSeconds(Math.Max(2, opts.CdsDiscovery.RequestTimeoutSeconds));
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", longToken);

            var url = JoinUrl(conn.PartnerBaseUrl, conn.InstanceDiscoveryUrl);
            var result = await FetchProjectInstancesAsync(http, url, ct);
            if (result.Error != null)
            {
                endpointFailures += 1;
                endpointFailureDetails.Add($"{ShortId(conn.Id)} {conn.ProjectId} {result.Error}");
                _logger.LogDebug("[CdsDiscovery] paired instance discovery failed connection={Id}: {Error}", conn.Id, result.Error);
                if (result.InvalidLongToken)
                {
                    await service.ProbeAsync(conn.Id, ct);
                }
                continue;
            }
            if (result.Envelope?.Instances == null)
            {
                endpointFailures += 1;
                endpointFailureDetails.Add($"{ShortId(conn.Id)} {conn.ProjectId} response_missing_instances");
                continue;
            }
            if (result.Envelope.Instances.Count == 0)
            {
                emptyEndpoints += 1;
                var discoverySummary = result.Envelope.Discovery == null
                    ? string.Empty
                    : " " + result.Envelope.Discovery.ToSummary();
                emptyEndpointDetails.Add($"{ShortId(conn.Id)} {conn.ProjectId} empty_instances{discoverySummary}");
                continue;
            }
            endpointsWithInstances += 1;

            var idx = 0;
            foreach (var inst in result.Envelope.Instances)
            {
                idx += 1;
                if (string.IsNullOrWhiteSpace(inst.BaseUrl) && (string.IsNullOrWhiteSpace(inst.Host) || inst.Port == null)) continue;
                var stable = !string.IsNullOrWhiteSpace(inst.HostId)
                    ? inst.HostId
                    : !string.IsNullOrWhiteSpace(inst.DeploymentId)
                        ? inst.DeploymentId
                        : idx.ToString();
                var tags = NormalizeInstanceTags(inst);
                discovered.Add(string.IsNullOrWhiteSpace(inst.BaseUrl)
                    ? ToDynamicInstance(
                        name: $"cds-pairing:{conn.Id}:{stable}",
                        host: inst.Host!,
                        port: inst.Port!.Value,
                        token: ResolveSharedSidecarToken(opts),
                        tags: tags,
                        source: "cds-pairing")
                    : ToDynamicInstance(
                        name: $"cds-pairing:{conn.Id}:{stable}",
                        baseUrl: inst.BaseUrl!,
                        token: ResolveSharedSidecarToken(opts),
                        tags: tags,
                        source: "cds-pairing"));
            }
        }
        if (discovered.Count == 0)
        {
            notes.Add(
                $"paired-connections total={connections.Count} activeCds={activeCds.Count} usable={usableConnections} tokenFailures={encryptedTokenFailures} endpointFailures={endpointFailures} emptyEndpoints={emptyEndpoints} endpointsWithInstances={endpointsWithInstances}");
            if (endpointFailureDetails.Count > 0)
            {
                notes.Add("paired-endpoint-failures " + string.Join(" | ", endpointFailureDetails.Take(5)));
            }
            if (emptyEndpointDetails.Count > 0)
            {
                notes.Add("paired-empty-endpoints " + string.Join(" | ", emptyEndpointDetails.Take(5)));
            }
        }

        return discovered;
    }

    private static async Task<ProjectInstancesResult> FetchProjectInstancesAsync(
        HttpClient http,
        string url,
        CancellationToken ct)
    {
        try
        {
            using var response = await http.GetAsync(url, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode)
            {
                return new ProjectInstancesResult(
                    null,
                    $"HTTP {(int)response.StatusCode} {TruncateOneLine(body, 180)}".Trim(),
                    BodyHasErrorCode(body, "invalid_long_token"));
            }
            if (string.IsNullOrWhiteSpace(body))
            {
                return new ProjectInstancesResult(null, "empty_body", false);
            }

            var envelope = JsonSerializer.Deserialize<ProjectInstancesEnvelope>(
                body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            return new ProjectInstancesResult(envelope, null, false);
        }
        catch (Exception ex)
        {
            return new ProjectInstancesResult(null, $"{ex.GetType().Name}: {TruncateOneLine(ex.Message, 180)}", false);
        }
    }

    private static bool BodyHasErrorCode(string body, string code)
    {
        if (string.IsNullOrWhiteSpace(body)) return false;
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return false;
            if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object)
            {
                return error.TryGetProperty("code", out var nestedCode)
                    && string.Equals(nestedCode.GetString(), code, StringComparison.OrdinalIgnoreCase);
            }
            return root.TryGetProperty("errorCode", out var topCode)
                && string.Equals(topCode.GetString(), code, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static string ShortId(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "unknown";
        return value.Length <= 8 ? value : value[..8];
    }

    private static string TruncateOneLine(string? value, int max)
    {
        var normalized = (value ?? string.Empty)
            .Replace("\r", " ", StringComparison.Ordinal)
            .Replace("\n", " ", StringComparison.Ordinal)
            .Trim();
        if (normalized.Length <= max) return normalized;
        return normalized[..max] + "...";
    }

    private static IReadOnlyList<string> NormalizeInstanceTags(InstanceDto inst)
    {
        var tags = new List<string>();
        if (inst.Tags != null)
        {
            tags.AddRange(inst.Tags.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()));
        }
        AddTag(tags, "profile", inst.ProfileId);
        AddTag(tags, "branch", inst.Branch);
        AddTag(tags, "branchId", inst.BranchId);
        AddTag(tags, "serviceKind", inst.ServiceKind);
        AddTag(tags, "projectKind", inst.ProjectKind);
        return tags.Distinct(StringComparer.OrdinalIgnoreCase).Take(24).ToList();
    }

    private static void AddTag(List<string> tags, string key, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        tags.Add($"{key}:{value.Trim()}");
    }

    private static DynamicSidecarInstance ToDynamicInstance(
        string name,
        string host,
        int port,
        string token,
        IReadOnlyList<string> tags,
        string source)
    {
        return new DynamicSidecarInstance
        {
            Name = name,
            BaseUrl = $"http://{host}:{port}",
            Token = token,
            Weight = 1,
            Tags = tags,
            Source = source,
        };
    }

    private static DynamicSidecarInstance ToDynamicInstance(
        string name,
        string baseUrl,
        string token,
        IReadOnlyList<string> tags,
        string source)
    {
        return new DynamicSidecarInstance
        {
            Name = name,
            BaseUrl = baseUrl.TrimEnd('/'),
            Token = token,
            Weight = 1,
            Tags = tags,
            Source = source,
        };
    }

    private static string ResolveSharedSidecarToken(ClaudeSidecarOptions opts) =>
        !string.IsNullOrWhiteSpace(opts.CdsDiscovery.SharedSidecarToken)
            ? opts.CdsDiscovery.SharedSidecarToken
            : opts.DefaultSidecarToken;

    private static string JoinUrl(string baseUrl, string path)
    {
        var b = (baseUrl ?? string.Empty).TrimEnd('/');
        var p = path ?? string.Empty;
        if (string.IsNullOrWhiteSpace(p)) return b;
        return p.StartsWith('/') ? b + p : b + "/" + p;
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

    private sealed class ProjectInstancesEnvelope
    {
        public string? ProjectId { get; set; }
        public List<InstanceDto>? Instances { get; set; }
        public ProjectInstancesDiscoveryDto? Discovery { get; set; }
    }

    private sealed class ProjectInstancesDiscoveryDto
    {
        public string? ProjectKind { get; set; }
        public int? DeploymentCount { get; set; }
        public int? RunningDeploymentCount { get; set; }
        public int? DisabledHostDeploymentCount { get; set; }
        public int? BranchCount { get; set; }
        public int? RunningBranchCount { get; set; }
        public int? RunningBranchServiceCount { get; set; }
        public int? RuntimeBranchServiceCount { get; set; }
        public int? SkippedBranchServiceCount { get; set; }
        public bool? PreviewRootConfigured { get; set; }

        public string ToSummary()
        {
            var parts = new List<string>
            {
                $"projectKind={ProjectKind ?? "unknown"}",
                $"deployments={DeploymentCount ?? 0}",
                $"runningDeployments={RunningDeploymentCount ?? 0}",
                $"disabledHostDeployments={DisabledHostDeploymentCount ?? 0}",
                $"branches={BranchCount ?? 0}",
                $"runningBranches={RunningBranchCount ?? 0}",
                $"runningBranchServices={RunningBranchServiceCount ?? 0}",
                $"runtimeBranchServices={RuntimeBranchServiceCount ?? 0}",
                $"skippedBranchServices={SkippedBranchServiceCount ?? 0}",
                $"previewRootConfigured={PreviewRootConfigured == true}",
            };
            return "discovery(" + string.Join(" ", parts) + ")";
        }
    }

    private sealed record ProjectInstancesResult(
        ProjectInstancesEnvelope? Envelope,
        string? Error,
        bool InvalidLongToken);

    private sealed class InstanceDto
    {
        public string? DeploymentId { get; set; }
        public string? ProfileId { get; set; }
        public string? BranchId { get; set; }
        public string? Branch { get; set; }
        public string? ServiceKind { get; set; }
        public string? ProjectKind { get; set; }
        public string? BaseUrl { get; set; }
        public string? Host { get; set; }
        public int? Port { get; set; }
        public bool? Healthy { get; set; }
        public string? Version { get; set; }
        public List<string>? Tags { get; set; }
        public string? HostName { get; set; }
        public string? HostId { get; set; }
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

}
