using Microsoft.Extensions.DependencyInjection;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// MAP 把 OpenDesign 任务交给谁执行（design.platform.design-runtime.md 第七节第 2、3 阶段）。
/// 运行时 id 始终是 open-design，界面不变；变的只是这一条传输面。
/// </summary>
public enum OpenDesignTransport
{
    /// <summary>按 map-design-executor-v1 直接调用独立部署的设计执行服务（design-opendesign）。</summary>
    Service,

    /// <summary>旧路径：经 CDS Remote Agent 会话起容器执行，保留一个版本作回退。</summary>
    CdsSession,
}

/// <summary>
/// 传输面的解析结果。<see cref="Problem"/> 非空表示运维显式要了 service、但地址或密钥缺失 / 不合法：
/// 这时不静默退回 cds-session（判据与接线纪律 形状 10），而是让能力探针与执行器把原因说出来。
/// </summary>
public sealed record OpenDesignTransportResolution(
    OpenDesignTransport Transport,
    Uri? BaseUrl,
    string? ApiKey,
    string? Problem)
{
    public string LogName => Transport == OpenDesignTransport.Service ? "service" : "cds-session";
}

/// <summary>
/// 传输面开关的唯一判定源。配置键：
/// <list type="bullet">
/// <item><c>DesignRuntime:OpenDesign:Transport</c> = <c>service</c> | <c>cds-session</c>（不填 = 自动）</item>
/// <item><c>DesignRuntime:OpenDesign:BaseUrl</c> / <c>DesignRuntime:OpenDesign:ApiKey</c>（cds-compose.yml 已注入）</item>
/// </list>
/// 自动时：地址与密钥都配好就走 service，否则走 cds-session——没有部署执行服务的环境行为与今天完全一样。
/// 显式写的值永远优先；显式 service 而缺地址 / 密钥时不退回旧路径，把缺什么如实报出来。
/// </summary>
public static class OpenDesignTransportResolver
{
    public const string TransportKey = "DesignRuntime:OpenDesign:Transport";
    public const string BaseUrlKey = "DesignRuntime:OpenDesign:BaseUrl";
    public const string ApiKeyKey = "DesignRuntime:OpenDesign:ApiKey";

    public static OpenDesignTransportResolution Resolve(IConfiguration configuration)
    {
        var rawTransport = configuration[TransportKey]?.Trim();
        var rawBaseUrl = Normalize(configuration[BaseUrlKey]);
        var apiKey = Normalize(configuration[ApiKeyKey]);
        Uri? baseUrl = null;
        string? baseUrlProblem = null;
        if (rawBaseUrl != null)
        {
            if (Uri.TryCreate(rawBaseUrl.TrimEnd('/'), UriKind.Absolute, out var parsed)
                && parsed.Scheme is "http" or "https")
                baseUrl = parsed;
            else
                baseUrlProblem = $"{BaseUrlKey} 的值不是 http(s) 绝对地址";
        }

        if (string.Equals(rawTransport, "cds-session", StringComparison.OrdinalIgnoreCase))
            return new(OpenDesignTransport.CdsSession, baseUrl, apiKey, null);

        var explicitService = string.Equals(rawTransport, "service", StringComparison.OrdinalIgnoreCase);
        if (!string.IsNullOrEmpty(rawTransport) && !explicitService)
        {
            return new(OpenDesignTransport.Service, baseUrl, apiKey,
                $"部署配置里 {TransportKey} 写的是「{rawTransport}」，MAP 只认 service 或 cds-session，于是 OpenDesign 暂不可用：" +
                $"需要处理：把它改成 service（直连设计执行服务）或 cds-session（退回经 CDS 会话的旧路径），或者删掉它让 MAP 按地址与密钥自动选择");
        }

        if (!explicitService)
        {
            // 自动：两项都齐才走新路径；缺任一项说明这套环境没部署执行服务，照旧走 CDS 会话。
            return baseUrl != null && apiKey != null
                ? new(OpenDesignTransport.Service, baseUrl, apiKey, null)
                : new(OpenDesignTransport.CdsSession, baseUrl, apiKey, null);
        }

        var missing = new List<string>();
        if (baseUrl == null) missing.Add(baseUrlProblem ?? $"{BaseUrlKey} 没有配置");
        if (apiKey == null) missing.Add($"{ApiKeyKey} 没有配置");
        return missing.Count == 0
            ? new(OpenDesignTransport.Service, baseUrl, apiKey, null)
            : new(OpenDesignTransport.Service, baseUrl, apiKey,
                $"部署配置指定 OpenDesign 直连设计执行服务，但{string.Join("、", missing)}，于是 OpenDesign 暂不可用：" +
                $"需要处理：在部署配置里补齐设计执行服务的地址与密钥（DESIGN_RUNTIME_API_KEY），或把 {TransportKey} 设为 cds-session 退回旧路径");
    }

    /// <summary>
    /// 空白与没被部署平台替换掉的 <c>${VAR}</c> 占位符都算「没配」：
    /// 把占位符原样当密钥发出去只会换来一次看不懂的 401。
    /// </summary>
    private static string? Normalize(string? value)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        if (trimmed.StartsWith("${", StringComparison.Ordinal) && trimmed.EndsWith('}')) return null;
        return trimmed;
    }
}

public static class OpenDesignTransportServiceCollectionExtensions
{
    public const string ServiceHttpClientName = "OpenDesignService";

    /// <summary>
    /// 两个执行器都注册成具体类型，但只有开关选中的那一个以 open-design 的
    /// <see cref="IDesignArtifactExecutor"/> / <see cref="IDesignArtifactProviderProbe"/> 身份出现：
    /// worker 与能力目录都按运行时 id 取「那一个」，同时出现两个会让选谁取决于注册顺序。
    /// </summary>
    public static IServiceCollection AddOpenDesignExecutors(this IServiceCollection services)
    {
        services.AddHttpClient(ServiceHttpClientName, client =>
        {
            // SSE 事件流是长连接；每个请求自己带超时，这里不设全局上限。
            client.Timeout = Timeout.InfiniteTimeSpan;
        });
        services.AddScoped<OpenDesignRemoteArtifactExecutor>();
        services.AddScoped<OpenDesignServiceArtifactExecutor>();
        services.AddScoped<IDesignArtifactExecutor>(Select);
        services.AddScoped<IDesignArtifactProviderProbe>(Select);
        return services;
    }

    internal static OpenDesignSelectedExecutor Select(IServiceProvider services)
    {
        var resolution = OpenDesignTransportResolver.Resolve(services.GetRequiredService<IConfiguration>());
        return resolution.Transport == OpenDesignTransport.Service
            ? new OpenDesignSelectedExecutor(services.GetRequiredService<OpenDesignServiceArtifactExecutor>())
            : new OpenDesignSelectedExecutor(services.GetRequiredService<OpenDesignRemoteArtifactExecutor>());
    }
}

/// <summary>
/// DI 工厂只能返回一个类型；这个薄壳让同一次选择同时充当执行器与探针，调用原样转给选中的那一个。
/// </summary>
internal sealed class OpenDesignSelectedExecutor : IDesignArtifactExecutor, IDesignArtifactProviderProbe
{
    private readonly IDesignArtifactExecutor _executor;
    private readonly IDesignArtifactProviderProbe _probe;

    internal OpenDesignSelectedExecutor(OpenDesignServiceArtifactExecutor selected)
    {
        _executor = selected;
        _probe = selected;
        Selected = selected;
    }

    internal OpenDesignSelectedExecutor(OpenDesignRemoteArtifactExecutor selected)
    {
        _executor = selected;
        _probe = selected;
        Selected = selected;
    }

    /// <summary>实际选中的执行器（测试与诊断用）。</summary>
    internal object Selected { get; }

    public string Runtime => _executor.Runtime;

    public bool Supports(string artifactType, string operation) => _executor.Supports(artifactType, operation);

    public IAsyncEnumerable<DesignArtifactExecutorChunk> ExecuteAsync(
        DesignArtifactRun run,
        string? currentHtml,
        CancellationToken ct) => _executor.ExecuteAsync(run, currentHtml, ct);

    public Task<DesignArtifactProviderProbeResult> ProbeAsync(string userId, CancellationToken ct) =>
        _probe.ProbeAsync(userId, ct);
}
