using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// OpenRouter 对外网关的韧性服务（Phase 2）：按 Key 限流桶 + 每日配额拦截 + 降级/配额预警 + 用量统计。
///
/// 所有方法对 Redis 异常 fail-open（放行），绝不因限流基础设施抖动打断网关主流程。
/// </summary>
public interface IOpenRouterUsageService
{
    /// <summary>
    /// 处理请求前的准入检查 + 占用（每分钟速率 + 每日请求配额 + 每日 token 配额预检）。
    /// 通过返回 Allowed=true 并已占用一个请求额度；拒绝返回 Code/Message + 建议 RetryAfter。
    /// </summary>
    Task<OpenRouterUsageDecision> CheckAndReserveAsync(AgentApiKey key, CancellationToken ct = default);

    /// <summary>请求完成后累加 token 用量；跨越配额阈值（80%/100%）时发管理预警（按天去重）。</summary>
    Task RecordTokensAsync(AgentApiKey key, int tokens, CancellationToken ct = default);

    /// <summary>已绑定专属模型的 Key 发生降级（IsFallback）时发管理预警（按天去重）。</summary>
    Task NotifyFallbackAsync(AgentApiKey key, string? resolvedModel, string? originalPool, string? reason, CancellationToken ct = default);

    /// <summary>读取某 Key 当日用量快照（请求数 + token），供管理面板展示。</summary>
    Task<OpenRouterUsageSnapshot> GetUsageAsync(string keyId, CancellationToken ct = default);
}

/// <summary>准入决策。</summary>
public sealed record OpenRouterUsageDecision(bool Allowed, string? Code, string? Message, int? RetryAfterSeconds)
{
    public static readonly OpenRouterUsageDecision Allow = new(true, null, null, null);
    public static OpenRouterUsageDecision Deny(string code, string message, int? retryAfter = null)
        => new(false, code, message, retryAfter);
}

/// <summary>当日用量快照。</summary>
public sealed class OpenRouterUsageSnapshot
{
    public long TodayRequests { get; init; }
    public long TodayTokens { get; init; }
}
