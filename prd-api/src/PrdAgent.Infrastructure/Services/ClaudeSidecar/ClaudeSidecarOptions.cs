namespace PrdAgent.Infrastructure.Services.ClaudeSidecar;

/// <summary>
/// appsettings.json 中 `ClaudeSdkExecutor` 配置段绑定到此类。
/// 多 Sidecar 实例 = 跨服务器/sandbox 部署的入口，由 RoutingStrategy 决定如何挑选。
/// </summary>
public sealed class ClaudeSidecarOptions
{
    public const string SectionName = "ClaudeSdkExecutor";

    /// <summary>未启用时 ExecuteCliAgent_ClaudeSdkAsync 会快速失败，避免 silent fallback。</summary>
    public bool Enabled { get; set; } = false;

    /// <summary>
    /// 零配置自启：如果设置为 true（默认）且检测到 ANTHROPIC_API_KEY 环境变量，
    /// 启动时会自动注入一个 default sidecar 实例并把 Enabled 置 true。
    /// 用户只需在 docker-compose / CDS 设 ANTHROPIC_API_KEY，其他全自动。
    /// </summary>
    public bool AutoConfigureFromEnv { get; set; } = true;

    /// <summary>AutoConfigureFromEnv 自动注入时使用的默认 sidecar 地址。</summary>
    public string DefaultSidecarBaseUrl { get; set; } = "http://claude-sidecar:7400";

    /// <summary>AutoConfigureFromEnv 自动注入时使用的默认 sidecar token。</summary>
    public string DefaultSidecarToken { get; set; } = "dev-skip";

    /// <summary>
    /// sidecar 实例列表，至少配 1 个。本地 / docker-compose / 远程 sandbox
    /// 的差异仅体现在 BaseUrl 与 Tags，业务代码完全无感知。
    /// </summary>
    public List<SidecarInstanceConfig> Sidecars { get; set; } = new();

    /// <summary>tag-weighted | round-robin | sticky-by-runId（默认 tag-weighted）</summary>
    public string RoutingStrategy { get; set; } = "tag-weighted";

    public HealthCheckConfig HealthCheck { get; set; } = new();
    public TimeoutConfig Timeouts { get; set; } = new();
    public RetryConfig Retry { get; set; } = new();

    /// <summary>sidecar 反向调主服务的 base URL，必须是 sidecar 网络可达的地址。</summary>
    public string CallbackBaseUrl { get; set; } = "http://api:8080";

    public string DefaultModel { get; set; } = "claude-opus-4-5";

    /// <summary>每次 run 给 sidecar 签发的临时 AgentApiKey 有效期（分钟）。</summary>
    public int EphemeralKeyTtlMinutes { get; set; } = 15;

    /// <summary>
    /// CDS 实例发现集成（2026-05-06）。
    /// 启用时，DynamicSidecarRegistry 会周期拉 CDS 的远程主机 + 当前实例 API
    /// 自动合并到路由实例列表（appsettings.Sidecars 静态配置始终优先）。
    /// 详见 doc/plan.cds-shared-service-extension.md。
    /// </summary>
    public CdsDiscoveryConfig CdsDiscovery { get; set; } = new();
}

public sealed class CdsDiscoveryConfig
{
    /// <summary>开关。未启用时 prd-api 仅消费 appsettings.Sidecars 静态配置。</summary>
    public bool Enabled { get; set; } = false;

    /// <summary>CDS 主服务的公网或内网 base URL，例 `https://cds.miduo.org`。</summary>
    public string BaseUrl { get; set; } = "";

    /// <summary>实例发现刷新间隔（秒）。</summary>
    public int RefreshIntervalSeconds { get; set; } = 30;

    /// <summary>
    /// 单一 sidecar token：CDS 通过部署表单注入到容器的 `SIDECAR_TOKEN` env 应与本字段相同。
    /// 这样 prd-api 调 CDS 部署的 sidecar 时无需逐 host 维护 token。
    /// </summary>
    public string SharedSidecarToken { get; set; } = "";

    /// <summary>调 CDS API 时携带的 Authorization header（如 CDS Agent Key）。</summary>
    public string CdsAuthHeader { get; set; } = "";

    /// <summary>HTTP 请求超时（秒）。</summary>
    public int RequestTimeoutSeconds { get; set; } = 8;
}

public sealed class SidecarInstanceConfig
{
    public string Name { get; set; } = "default";
    public string BaseUrl { get; set; } = string.Empty;
    public int Weight { get; set; } = 1;
    public List<string> Tags { get; set; } = new();

    /// <summary>主服务用此 token 鉴权调 sidecar，对应 sidecar 的 SIDECAR_TOKEN 环境变量。</summary>
    public string Token { get; set; } = string.Empty;

    /// <summary>从配置读取 token 失败时的备选 env var 名（如 "CLAUDE_SIDECAR_TOKEN_PROD"）。</summary>
    public string? TokenEnvVar { get; set; }
}

public sealed class HealthCheckConfig
{
    public string Path { get; set; } = "/healthz";
    public int IntervalSeconds { get; set; } = 10;
    public int UnhealthyThreshold { get; set; } = 3;
    public int TimeoutSeconds { get; set; } = 3;
}

public sealed class TimeoutConfig
{
    public int ConnectMs { get; set; } = 3000;
    public int RequestSeconds { get; set; } = 600;
    public int IdleStreamSeconds { get; set; } = 60;
}

public sealed class RetryConfig
{
    public int MaxAttempts { get; set; } = 2;
    public int[] BackoffMs { get; set; } = new[] { 500, 2000 };
}
