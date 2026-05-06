namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 动态 sidecar 实例发现注册表。
///
/// 数据源 = appsettings.json 静态 Sidecars[] + 周期拉 CDS 实例发现 API（如启用）。
/// ClaudeSidecarRouter 通过本接口拿到当前应路由的所有实例，无需关心来源差异。
///
/// 静态优先：appsettings 配置的实例永远在前；CDS 发现的追加在后。
/// 这样本地开发 / 离线环境（无 CDS）下行为不变；一旦 CDS Discovery 开启，
/// 自动新增的远程主机即时进入路由池，无需重启 prd-api。
///
/// 详见 doc/plan.cds-shared-service-extension.md。
/// </summary>
public interface IDynamicSidecarRegistry
{
    /// <summary>当前应路由的实例列表（静态 + 动态合并）。</summary>
    IReadOnlyList<DynamicSidecarInstance> GetCurrent();

    /// <summary>立即触发一次 CDS 同步（HostedService 周期触发，亦可手动调试用）。</summary>
    Task RefreshAsync(CancellationToken ct);

    /// <summary>最近一次 CDS 同步时间（null = 从未同步成功）。</summary>
    DateTime? LastRefreshedAt { get; }

    /// <summary>最近一次同步异常信息（null = 上次同步成功）。</summary>
    string? LastRefreshError { get; }
}

/// <summary>
/// 一个 sidecar 实例对路由器的视图。屏蔽来源（静态 / CDS）差异，由注册表合并产出。
/// 与 SidecarInstanceConfig 重叠但更窄 —— 仅暴露路由器需要的字段。
/// </summary>
public sealed class DynamicSidecarInstance
{
    /// <summary>稳定标识；静态实例 = appsettings 中的 Name；CDS 实例 = "cds:&lt;hostId&gt;"。</summary>
    public string Name { get; init; } = string.Empty;

    /// <summary>BaseUrl，例 `http://1.2.3.4:7400`。</summary>
    public string BaseUrl { get; init; } = string.Empty;

    /// <summary>调用此实例使用的 Bearer token。</summary>
    public string Token { get; init; } = string.Empty;

    /// <summary>路由权重（默认 1）。</summary>
    public int Weight { get; init; } = 1;

    /// <summary>路由标签（如 ["prod","asia"]）。</summary>
    public IReadOnlyList<string> Tags { get; init; } = Array.Empty<string>();

    /// <summary>来源："static" 或 "cds"。仅做诊断用。</summary>
    public string Source { get; init; } = "static";
}
