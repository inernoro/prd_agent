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
    IReadOnlyList<string> SourceSurfaces,
    string? ConfigurationSection = null,
    string HealthPath = "health");

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
    Task<IReadOnlyList<DesignArtifactProviderCapability>> ListAsync(CancellationToken ct = default);

    Task<DesignArtifactProviderCapability?> FindAsync(string runtime, CancellationToken ct = default);
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
            "OpenDesign",
            "DesignGeneration:Runtimes:OpenDesign");
        yield return Remote(
            DesignArtifactRuntimes.Codex,
            "Codex",
            "DesignGeneration:Runtimes:Codex");
        yield return Remote(
            DesignArtifactRuntimes.Claude,
            "Claude",
            "DesignGeneration:Runtimes:Claude");
    }

    private static DesignArtifactProviderDefinition Remote(string id, string label, string configurationSection) => new(
        id,
        label,
        DesignArtifactAdapterKinds.RemoteAgent,
        DesignArtifactExecutionOwners.CdsRemoteAgent,
        DesignArtifactIsolationModes.SessionContainer,
        [DesignArtifactTypes.WebPage],
        WebPageOperations,
        WebPageSources,
        configurationSection);
}

public sealed class DesignArtifactProviderCatalog : IDesignArtifactProviderCatalog
{
    private readonly IReadOnlyList<DesignArtifactProviderDefinition> _definitions;
    private readonly HashSet<string> _executorRuntimes;
    private readonly IConfiguration _configuration;
    private readonly IHttpClientFactory _httpClientFactory;

    public DesignArtifactProviderCatalog(
        IEnumerable<IDesignArtifactProviderDefinitionSource> definitionSources,
        IEnumerable<IDesignArtifactExecutor> executors,
        IConfiguration configuration,
        IHttpClientFactory httpClientFactory)
    {
        _definitions = definitionSources
            .SelectMany(source => source.GetDefinitions())
            .GroupBy(definition => definition.Id, StringComparer.Ordinal)
            .Select(group => group.Last())
            .ToList();
        _executorRuntimes = executors.Select(executor => executor.Runtime).ToHashSet(StringComparer.Ordinal);
        _configuration = configuration;
        _httpClientFactory = httpClientFactory;
    }

    public async Task<IReadOnlyList<DesignArtifactProviderCapability>> ListAsync(CancellationToken ct = default)
    {
        var capabilities = await Task.WhenAll(_definitions.Select(InspectAsync));
        return capabilities;
    }

    public async Task<DesignArtifactProviderCapability?> FindAsync(string runtime, CancellationToken ct = default)
    {
        var definition = _definitions.FirstOrDefault(item =>
            string.Equals(item.Id, runtime, StringComparison.OrdinalIgnoreCase));
        return definition == null ? null : await InspectAsync(definition);
    }

    private async Task<DesignArtifactProviderCapability> InspectAsync(DesignArtifactProviderDefinition definition)
    {
        var hasAdapter = _executorRuntimes.Contains(definition.Id);
        if (definition.ConfigurationSection == null)
        {
            return ToCapability(
                definition,
                configured: true,
                healthy: hasAdapter,
                enabled: hasAdapter,
                reason: hasAdapter ? null : "MAP 中尚未注册该执行器适配器");
        }

        Uri? baseUri = null;
        var configured = _configuration.GetValue<bool>($"{definition.ConfigurationSection}:Enabled")
                         && Uri.TryCreate(
                             _configuration[$"{definition.ConfigurationSection}:BaseUrl"],
                             UriKind.Absolute,
                             out baseUri);
        if (!configured)
        {
            return ToCapability(
                definition,
                configured: false,
                healthy: false,
                enabled: false,
                reason: "CDS Remote Agent 中尚未配置该执行器运行时");
        }

        var healthy = false;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            var client = _httpClientFactory.CreateClient();
            using var response = await client.GetAsync(new Uri(baseUri!, definition.HealthPath), timeout.Token);
            healthy = response.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            healthy = false;
        }

        return ToCapability(
            definition,
            configured: true,
            healthy,
            enabled: healthy && hasAdapter,
            reason: !healthy
                ? "运行时已配置但健康检查未通过"
                : hasAdapter
                    ? null
                    : "运行时已探测到，但 MAP 提供者适配器尚未安装");
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
}
