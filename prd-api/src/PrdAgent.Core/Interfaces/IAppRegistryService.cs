using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 应用注册中心服务接口
/// </summary>
public interface IAppRegistryService
{
    // ==================== 应用管理 ====================

    /// <summary>获取所有已注册应用</summary>
    Task<List<RegisteredApp>> GetAppsAsync(bool includeInactive = false, CancellationToken ct = default);

    /// <summary>根据 AppId 获取应用</summary>
    Task<RegisteredApp?> GetAppByIdAsync(string appId, CancellationToken ct = default);

    /// <summary>根据 MongoDB ID 获取应用</summary>
    Task<RegisteredApp?> GetAppByMongoIdAsync(string id, CancellationToken ct = default);

    /// <summary>注册应用</summary>
    Task<RegisteredApp> RegisterAppAsync(RegisterAppRequest request, CancellationToken ct = default);

    /// <summary>更新应用</summary>
    Task<RegisteredApp> UpdateAppAsync(string appId, UpdateAppRequest request, CancellationToken ct = default);

    /// <summary>注销应用</summary>
    Task DeleteAppAsync(string appId, CancellationToken ct = default);

    /// <summary>切换应用状态</summary>
    Task<RegisteredApp> ToggleAppStatusAsync(string appId, CancellationToken ct = default);

    /// <summary>更新应用心跳</summary>
    Task UpdateHeartbeatAsync(string appId, CancellationToken ct = default);

    // ==================== 桩应用 ====================

    /// <summary>创建桩应用</summary>
    Task<RegisteredApp> CreateStubAppAsync(CreateStubAppRequest request, CancellationToken ct = default);

    /// <summary>更新桩应用配置</summary>
    Task<RegisteredApp> UpdateStubConfigAsync(string appId, StubAppConfig config, CancellationToken ct = default);

    // ==================== 路由规则 ====================

    /// <summary>获取所有路由规则</summary>
    Task<List<RoutingRule>> GetRoutingRulesAsync(bool includeInactive = false, CancellationToken ct = default);

    /// <summary>根据 ID 获取路由规则</summary>
    Task<RoutingRule?> GetRoutingRuleAsync(string id, CancellationToken ct = default);

    /// <summary>创建路由规则</summary>
    Task<RoutingRule> CreateRoutingRuleAsync(CreateRoutingRuleRequest request, CancellationToken ct = default);

    /// <summary>更新路由规则</summary>
    Task<RoutingRule> UpdateRoutingRuleAsync(string id, UpdateRoutingRuleRequest request, CancellationToken ct = default);

    /// <summary>删除路由规则</summary>
    Task DeleteRoutingRuleAsync(string id, CancellationToken ct = default);

    /// <summary>切换规则状态</summary>
    Task<RoutingRule> ToggleRuleStatusAsync(string id, CancellationToken ct = default);

    // ==================== 路由调度 ====================

    /// <summary>根据请求匹配目标应用</summary>
    Task<(RegisteredApp? App, RoutingRule? MatchedRule)> ResolveAppAsync(UnifiedAppRequest request, CancellationToken ct = default);

    // ==================== 应用调用 ====================

    /// <summary>调用应用</summary>
    Task<UnifiedAppResponse> InvokeAppAsync(string appId, UnifiedAppRequest request, CancellationToken ct = default);
}

// ==================== 请求模型 ====================

public class RegisterAppRequest
{
    public string AppId { get; set; } = null!;
    public string AppName { get; set; } = null!;
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public string Version { get; set; } = "1.0.0";
    public AppCapabilities? Capabilities { get; set; }
    public AppInputSchema? InputSchema { get; set; }
    public AppOutputSchema? OutputSchema { get; set; }
    public string Endpoint { get; set; } = null!;
    public bool SupportsStreaming { get; set; }
    public bool SupportsStatusCallback { get; set; }
    public string? CallbackUrl { get; set; }
    public AppAuthType AuthType { get; set; } = AppAuthType.None;
    public string? ApiKey { get; set; }
}

public class UpdateAppRequest
{
    public string? AppName { get; set; }
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public string? Version { get; set; }
    public AppCapabilities? Capabilities { get; set; }
    public AppInputSchema? InputSchema { get; set; }
    public AppOutputSchema? OutputSchema { get; set; }
    public string? Endpoint { get; set; }
    public bool? SupportsStreaming { get; set; }
    public bool? SupportsStatusCallback { get; set; }
    public string? CallbackUrl { get; set; }
    public AppAuthType? AuthType { get; set; }
    public string? ApiKey { get; set; }
}

public class CreateStubAppRequest
{
    public string AppId { get; set; } = null!;
    public string AppName { get; set; } = null!;
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public StubAppConfig StubConfig { get; set; } = new();
}

public class CreateRoutingRuleRequest
{
    public string Name { get; set; } = null!;
    public string? Description { get; set; }
    public int Priority { get; set; } = 100;
    public RuleCondition Condition { get; set; } = new();
    public string TargetAppId { get; set; } = null!;
    public Dictionary<string, object>? ActionParams { get; set; }
}

public class UpdateRoutingRuleRequest
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public int? Priority { get; set; }
    public RuleCondition? Condition { get; set; }
    public string? TargetAppId { get; set; }
    public Dictionary<string, object>? ActionParams { get; set; }
}
