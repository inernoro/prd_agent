using PrdAgent.Core.Models;

namespace PrdAgent.Core.LlmGateway;

/// <summary>
/// 熔断与半开恢复的唯一判据源。
///
/// 这里收敛的是一件曾经写了两遍的事：逻辑模型 Offering 与模型池成员各自硬编码了一份
/// 「连续失败几次算不可用」的字面量。两份数字当时恰好相同，但没有任何东西保证它们
/// 一起改——判据分裂之后各自漂移，是本仓库反复出现的形状。
///
/// 阈值刻意保持常量而非配置：后台那张「调度器配置」表单历史上可以填阈值却没有任何
/// 运行时代码读它，填了不生效比不能填更糟。要放开成配置，必须同时接上读取方。
/// </summary>
public static class GatewayCircuitBreakerPolicy
{
    /// <summary>连续失败达到这个次数，成员判为不可用（从候选里摘掉）。</summary>
    public const int FailuresToUnavailable = 5;

    /// <summary>连续失败达到这个次数，成员判为降权（仍可用但排在健康成员之后）。</summary>
    public const int FailuresToDegraded = 3;

    /// <summary>不可用后要冷却多久才允许尝试半开验证。</summary>
    public const int DefaultHalfOpenAfterSeconds = 120;

    /// <summary>半开租约时长：同一时刻只有一个请求能拿着不可用成员去试探。</summary>
    public const int DefaultHalfOpenLeaseSeconds = 30;

    public const string HalfOpenAfterSecondsKey = "LlmGateway:CircuitBreaker:HalfOpenAfterSeconds";
    public const string HalfOpenLeaseSecondsKey = "LlmGateway:CircuitBreaker:HalfOpenLeaseSeconds";

    /// <summary>
    /// 一条被摘掉的线路（或池成员），此刻还够不够格被拿去做半开试探。
    ///
    /// 收在这里而不是各写各的：这个判断至少有三个消费方，而它们的口径必须一模一样——
    ///   - 解析时的认领（ModelResolver）：谁真的被顶到发送队列首位；
    ///   - 对外清单 /v1/models：一个只剩半开候选的模型还算不算「能调」。
    ///     漏了它会形成死锁：模型从清单里消失 → 靠清单发现模型的客户端永远不会发出
    ///     那次请求 → 而那次请求正是唯一能触发试探、让它回来的东西。**连管理员点过
    ///     手动恢复都救不回来**（第 80 轮 review）；
    ///   - 控制台「调用全貌」面板：那句「下一条请求可能先拿它做试探」。
    ///
    /// 判据三条：没有还没过期的半开租约、而且「人工点了恢复」或「上次失败已过冷却/根本没失败过」。
    /// Enabled 不在这里——它在各消费方自己的过滤条件里（认领那一侧写在 Mongo 过滤器上）。
    /// </summary>
    public static bool IsHalfOpenEligible(
        ModelHealthStatus healthStatus,
        DateTime? halfOpenLeaseUntil,
        DateTime? manualRecoveryAt,
        DateTime? lastFailedAt,
        DateTime nowUtc,
        DateTime cutoffUtc)
        => healthStatus == ModelHealthStatus.Unavailable
           && (!halfOpenLeaseUntil.HasValue || halfOpenLeaseUntil <= nowUtc)
           && ((manualRecoveryAt.HasValue && manualRecoveryAt <= nowUtc)
               || !lastFailedAt.HasValue
               || lastFailedAt <= cutoffUtc);

    /// <summary>按连续失败次数判定健康状态。</summary>
    public static ModelHealthStatus ClassifyByFailures(int consecutiveFailures)
        => consecutiveFailures >= FailuresToUnavailable ? ModelHealthStatus.Unavailable
            : consecutiveFailures >= FailuresToDegraded ? ModelHealthStatus.Degraded
            : ModelHealthStatus.Healthy;

    /// <summary>
    /// 失败路径只允许把健康状态往坏处写。
    ///
    /// 计数用 $inc 原子累加，状态却要由计数推出来——并发失败时各请求读到的都是自增前的
    /// 旧快照，谁最后落笔谁说了算，于是计数已经冲到几十、状态却被写回健康，断路器迟迟
    /// 不跳。单调收敛这条约束让「后到的旧快照」最多不生效，不会把状态改好。
    /// </summary>
    public static bool IsEscalation(ModelHealthStatus current, ModelHealthStatus next)
        => (int)next > (int)current;

    public static int ResolveHalfOpenAfterSeconds(int? configured)
        => Math.Clamp(configured ?? DefaultHalfOpenAfterSeconds, 10, 3600);

    public static int ResolveHalfOpenLeaseSeconds(int? configured)
        => Math.Clamp(configured ?? DefaultHalfOpenLeaseSeconds, 5, 300);
}
