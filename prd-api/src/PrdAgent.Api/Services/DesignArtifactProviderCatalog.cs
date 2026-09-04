using Microsoft.Extensions.Caching.Memory;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

public static class DesignArtifactAdapterKinds
{
    public const string InProcess = "in-process";
    public const string RemoteAgent = "remote-agent";
}

public static class DesignArtifactExecutionOwners
{
    public const string Map = "map";
    public const string CdsRemoteAgent = "cds-remote-agent";
}

public static class DesignArtifactIsolationModes
{
    public const string Process = "map-process";
    public const string SessionContainer = "session-container";
}

public sealed record DesignArtifactProviderDefinition(
    string Id,
    string Label,
    string AdapterKind,
    string ExecutionOwner,
    string IsolationMode,
    IReadOnlyList<string> ArtifactTypes,
    IReadOnlyList<string> Operations,
    IReadOnlyList<string> SourceSurfaces);

public sealed record DesignArtifactProviderCapability(
    string Id,
    string Label,
    string AdapterKind,
    string ExecutionOwner,
    string IsolationMode,
    IReadOnlyList<string> ArtifactTypes,
    IReadOnlyList<string> Operations,
    IReadOnlyList<string> SourceSurfaces,
    bool Configured,
    bool Healthy,
    bool Enabled,
    string? Reason);

/// <summary>每个设计插件通过 DI 注册定义源，不要求统一控制器认识插件名称。</summary>
public interface IDesignArtifactProviderDefinitionSource
{
    IEnumerable<DesignArtifactProviderDefinition> GetDefinitions();
}

public interface IDesignArtifactProviderCatalog
{
    Task<IReadOnlyList<DesignArtifactProviderCapability>> ListAsync(string userId, CancellationToken ct = default);

    Task<DesignArtifactProviderCapability?> FindAsync(string userId, string runtime, CancellationToken ct = default);
}

public sealed record DesignArtifactProviderProbeResult(
    bool Configured,
    bool Healthy,
    bool Enabled,
    string? Reason);

/// <summary>远程 Provider 的运行事实探针。事实必须来自执行归属方，不能由 MAP 静态开关代替。</summary>
public interface IDesignArtifactProviderProbe
{
    string Runtime { get; }

    Task<DesignArtifactProviderProbeResult> ProbeAsync(string userId, CancellationToken ct);
}

/// <summary>内置目录只定义产品已知的初始提供者；外部包可以追加定义源与执行器。</summary>
public sealed class BuiltInDesignArtifactProviderDefinitionSource : IDesignArtifactProviderDefinitionSource
{
    private static readonly string[] WebPageOperations =
        [DesignArtifactOperations.Generate, DesignArtifactOperations.Edit];
    private static readonly string[] WebPageSources =
        [DesignArtifactSourceSurfaces.WebHosting, DesignArtifactSourceSurfaces.KnowledgeBase];

    public IEnumerable<DesignArtifactProviderDefinition> GetDefinitions()
    {
        yield return new DesignArtifactProviderDefinition(
            DesignArtifactRuntimes.MapGateway,
            "MAP 模型",
            DesignArtifactAdapterKinds.InProcess,
            DesignArtifactExecutionOwners.Map,
            DesignArtifactIsolationModes.Process,
            [DesignArtifactTypes.WebPage],
            WebPageOperations,
            WebPageSources);
        yield return Remote(
            DesignArtifactRuntimes.OpenDesign,
            "OpenDesign");
        yield return Remote(
            DesignArtifactRuntimes.Codex,
            "Codex");
        yield return Remote(
            DesignArtifactRuntimes.Claude,
            "Claude");
    }

    private static DesignArtifactProviderDefinition Remote(string id, string label) => new(
        id,
        label,
        DesignArtifactAdapterKinds.RemoteAgent,
        DesignArtifactExecutionOwners.CdsRemoteAgent,
        DesignArtifactIsolationModes.SessionContainer,
        [DesignArtifactTypes.WebPage],
        WebPageOperations,
        WebPageSources);
}

public sealed class DesignArtifactProviderCatalog : IDesignArtifactProviderCatalog
{
    private static readonly TimeSpan PositiveCapabilityCacheDuration = TimeSpan.FromSeconds(60);
    private readonly IReadOnlyList<DesignArtifactProviderDefinition> _definitions;
    private readonly HashSet<string> _executorRuntimes;
    private readonly IReadOnlyDictionary<string, IDesignArtifactProviderProbe> _probes;
    private readonly IMemoryCache _cache;
    private readonly TimeSpan _positiveCapabilityCacheDuration;

    public DesignArtifactProviderCatalog(
        IEnumerable<IDesignArtifactProviderDefinitionSource> definitionSources,
        IEnumerable<IDesignArtifactExecutor> executors,
        IEnumerable<IDesignArtifactProviderProbe> probes,
        IMemoryCache cache)
        : this(
            definitionSources,
            executors,
            probes,
            cache,
            PositiveCapabilityCacheDuration)
    {
    }

    internal DesignArtifactProviderCatalog(
        IEnumerable<IDesignArtifactProviderDefinitionSource> definitionSources,
        IEnumerable<IDesignArtifactExecutor> executors,
        IEnumerable<IDesignArtifactProviderProbe> probes,
        IMemoryCache cache,
        TimeSpan positiveCapabilityCacheDuration)
    {
        _definitions = definitionSources
            .SelectMany(source => source.GetDefinitions())
            .GroupBy(definition => definition.Id, StringComparer.Ordinal)
            .Select(group => group.Last())
            .ToList();
        _executorRuntimes = executors.Select(executor => executor.Runtime).ToHashSet(StringComparer.Ordinal);
        _probes = probes
            .GroupBy(probe => probe.Runtime, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Last(), StringComparer.Ordinal);
        _cache = cache;
        _positiveCapabilityCacheDuration = positiveCapabilityCacheDuration;
    }

    public async Task<IReadOnlyList<DesignArtifactProviderCapability>> ListAsync(
        string userId,
        CancellationToken ct = default)
    {
        var capabilities = await Task.WhenAll(_definitions.Select(definition => InspectAsync(userId, definition, ct)));
        return capabilities;
    }

    public async Task<DesignArtifactProviderCapability?> FindAsync(
        string userId,
        string runtime,
        CancellationToken ct = default)
    {
        var definition = _definitions.FirstOrDefault(item =>
            string.Equals(item.Id, runtime, StringComparison.OrdinalIgnoreCase));
        return definition == null ? null : await InspectAsync(userId, definition, ct);
    }

    private async Task<DesignArtifactProviderCapability> InspectAsync(
        string userId,
        DesignArtifactProviderDefinition definition,
        CancellationToken ct)
    {
        var hasAdapter = _executorRuntimes.Contains(definition.Id);
        if (!hasAdapter)
        {
            return ToCapability(
                definition,
                configured: false,
                healthy: false,
                enabled: false,
                reason: "MAP 中尚未注册该执行器适配器");
        }

        if (definition.AdapterKind == DesignArtifactAdapterKinds.InProcess)
        {
            return ToCapability(
                definition,
                configured: true,
                healthy: true,
                enabled: true,
                reason: null);
        }

        if (!_probes.TryGetValue(definition.Id, out var probe))
        {
            return ToCapability(
                definition,
                configured: false,
                healthy: false,
                enabled: false,
                reason: "MAP 中尚未注册该远程执行器的运行事实探针");
        }

        var cacheKey = new PositiveCapabilityCacheKey(userId, definition.Id);
        try
        {
            var result = await probe.ProbeAsync(userId, ct);
            if (result.Enabled)
            {
                _cache.Set(cacheKey, result, _positiveCapabilityCacheDuration);
            }
            else
            {
                // CDS 明确返回 disabled 是新的权威事实，不能被旧的正向快照遮蔽。
                _cache.Remove(cacheKey);
            }
            return ToCapability(
                definition,
                result.Configured,
                result.Healthy,
                result.Enabled,
                result.Reason);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            if (TryGetRecentPositiveCapability(cacheKey, out var cached))
                return ToCapability(definition, cached.Configured, cached.Healthy, cached.Enabled, cached.Reason);
            return ToCapability(
                definition,
                configured: false,
                healthy: false,
                enabled: false,
                reason: "CDS Remote Agent 运行事实探测超时，请稍后重试");
        }
        catch (OperationCanceledException)
        {
            // 请求自身已取消时必须向上传递，不能把过期请求伪装成可用能力。
            throw;
        }
        catch (Exception)
        {
            if (TryGetRecentPositiveCapability(cacheKey, out var cached))
                return ToCapability(definition, cached.Configured, cached.Healthy, cached.Enabled, cached.Reason);
            return ToCapability(
                definition,
                configured: false,
                healthy: false,
                enabled: false,
                reason: "暂时无法读取 CDS Remote Agent 运行事实，请检查系统连接");
        }
    }

    private bool TryGetRecentPositiveCapability(
        PositiveCapabilityCacheKey cacheKey,
        out DesignArtifactProviderProbeResult capability)
    {
        if (_cache.TryGetValue(cacheKey, out DesignArtifactProviderProbeResult? cached)
            && cached is { Enabled: true })
        {
            capability = cached;
            return true;
        }

        capability = default!;
        return false;
    }

    private static DesignArtifactProviderCapability ToCapability(
        DesignArtifactProviderDefinition definition,
        bool configured,
        bool healthy,
        bool enabled,
        string? reason) => new(
            definition.Id,
            definition.Label,
            definition.AdapterKind,
            definition.ExecutionOwner,
            definition.IsolationMode,
            definition.ArtifactTypes,
            definition.Operations,
            definition.SourceSurfaces,
            configured,
            healthy,
            enabled,
            reason);

    private readonly record struct PositiveCapabilityCacheKey(string UserId, string Runtime);
}
