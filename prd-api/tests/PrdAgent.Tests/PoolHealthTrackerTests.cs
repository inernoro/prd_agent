using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.Infrastructure.ModelPool.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// PoolHealthTracker 单元测试（CI 可运行）
/// 重点验证 Half-Open 熔断器逻辑：
/// 1. Unavailable 端点在冷却期内应被拒绝
/// 2. 冷却期到期后第一个请求被放行（Half-Open 探针）
/// 3. 探针放行后，后续并发请求应被拒绝（防雷群效应）
/// 4. RecordSuccess / RecordFailure 均会重置探针标志
/// </summary>
public class PoolHealthTrackerTests
{
    private const string EndpointId = "platform-1:model-gpt4";

    // ─── 基础状态测试 ─────────────────────────────────────────────

    [Fact]
    public void UnknownEndpoint_IsAvailable_ReturnsTrue()
    {
        var tracker = new PoolHealthTracker();
        Assert.True(tracker.IsAvailable("does-not-exist"));
    }

    [Fact]
    public void HealthyEndpoint_IsAvailable_ReturnsTrue()
    {
        var tracker = new PoolHealthTracker();
        tracker.RecordSuccess(EndpointId, 100);
        Assert.True(tracker.IsAvailable(EndpointId));
    }

    [Fact]
    public void DegradedEndpoint_IsAvailable_ReturnsTrue()
    {
        var tracker = new PoolHealthTracker { DegradeThreshold = 2, UnavailableThreshold = 5 };
        tracker.RecordFailure(EndpointId);
        tracker.RecordFailure(EndpointId);
        tracker.RecordFailure(EndpointId);
        Assert.Equal(EndpointHealthStatus.Degraded, tracker.GetStatus(EndpointId));
        Assert.True(tracker.IsAvailable(EndpointId));
    }

    [Fact]
    public void UnavailableEndpoint_IsAvailable_ReturnsFalse()
    {
        var tracker = new PoolHealthTracker { UnavailableThreshold = 3, HalfOpenCooldownSeconds = 300 };
        tracker.RecordFailure(EndpointId);
        tracker.RecordFailure(EndpointId);
        tracker.RecordFailure(EndpointId);
        Assert.Equal(EndpointHealthStatus.Unavailable, tracker.GetStatus(EndpointId));
        Assert.False(tracker.IsAvailable(EndpointId));
    }

    // ─── Half-Open 核心逻辑 ───────────────────────────────────────

    [Fact]
    public void HalfOpen_Disabled_UnavailableAlwaysRejected()
    {
        // HalfOpenCooldownSeconds = 0 → 禁用 Half-Open，端点一旦 Unavailable 就不再自动恢复
        var tracker = new PoolHealthTracker { UnavailableThreshold = 1, HalfOpenCooldownSeconds = 0 };
        tracker.RecordFailure(EndpointId);
        Assert.Equal(EndpointHealthStatus.Unavailable, tracker.GetStatus(EndpointId));

        // 即使等很久也不应放行
        Assert.False(tracker.IsAvailable(EndpointId));
    }

    [Fact]
    public void HalfOpen_CooldownNotExpired_StillRejected()
    {
        // 使用很长的冷却期，模拟"尚未到期"
        var tracker = new PoolHealthTracker { UnavailableThreshold = 1, HalfOpenCooldownSeconds = 3600 };
        tracker.RecordFailure(EndpointId);
        Assert.False(tracker.IsAvailable(EndpointId));
    }

    [Fact]
    public void HalfOpen_CooldownExpired_FirstRequestAllowed()
    {
        // 冷却期设为 0 秒（已过期），应放行第一个请求
        var tracker = new PoolHealthTracker { UnavailableThreshold = 1, HalfOpenCooldownSeconds = 1 };
        tracker.RecordFailure(EndpointId);

        // 手动把 LastFailedAt 设为很久以前（模拟冷却期到期）
        SimulateExpiredCooldown(tracker, EndpointId);

        Assert.True(tracker.IsAvailable(EndpointId));
    }

    [Fact]
    public void HalfOpen_OnlyOneProbeAllowed_SubsequentRequestsRejected()
    {
        // 关键测试：防雷群效应
        // 冷却期到期后，第一个请求放行，后续并发请求应被拒绝
        var tracker = new PoolHealthTracker { UnavailableThreshold = 1, HalfOpenCooldownSeconds = 1 };
        tracker.RecordFailure(EndpointId);
        SimulateExpiredCooldown(tracker, EndpointId);

        // 第一个请求：放行（Half-Open 探针）
        bool first = tracker.IsAvailable(EndpointId);
        // 第二个请求（并发）：应被拒绝
        bool second = tracker.IsAvailable(EndpointId);
        // 第三个请求（并发）：应被拒绝
        bool third = tracker.IsAvailable(EndpointId);

        Assert.True(first, "第一个请求应被放行作为 Half-Open 探针");
        Assert.False(second, "探针在途时第二个请求应被拒绝（防雷群）");
        Assert.False(third, "探针在途时第三个请求应被拒绝（防雷群）");
    }

    [Fact]
    public void HalfOpen_AfterProbeSuccess_NewProbeAllowed()
    {
        // 探针成功（RecordSuccess）后重置标志，下次冷却到期可再放行
        var tracker = new PoolHealthTracker { UnavailableThreshold = 1, HalfOpenCooldownSeconds = 1 };
        tracker.RecordFailure(EndpointId);
        SimulateExpiredCooldown(tracker, EndpointId);

        // 第一轮探针放行
        bool probe1 = tracker.IsAvailable(EndpointId);
        Assert.True(probe1);

        // 探针成功 → 端点恢复 Healthy，重置 IsHalfOpenProbing
        tracker.RecordSuccess(EndpointId, 50);
        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus(EndpointId));

        // 现在端点是 Healthy，应可用
        Assert.True(tracker.IsAvailable(EndpointId));
    }

    [Fact]
    public void HalfOpen_AfterProbeFailure_ProbeResetAllowsNextRound()
    {
        // 探针失败（RecordFailure）后重置标志，等下次冷却再到期
        var tracker = new PoolHealthTracker { UnavailableThreshold = 1, HalfOpenCooldownSeconds = 1 };
        tracker.RecordFailure(EndpointId);
        SimulateExpiredCooldown(tracker, EndpointId);

        // 第一轮探针放行
        bool probe1 = tracker.IsAvailable(EndpointId);
        Assert.True(probe1);

        // 此时还有探针在途（IsHalfOpenProbing=true），应被拒绝
        Assert.False(tracker.IsAvailable(EndpointId));

        // 探针失败（端点仍然 Unavailable）
        tracker.RecordFailure(EndpointId);
        Assert.Equal(EndpointHealthStatus.Unavailable, tracker.GetStatus(EndpointId));

        // 探针标志已重置，但 LastFailedAt 更新为刚才——冷却期重启，此时应再次被拒绝
        Assert.False(tracker.IsAvailable(EndpointId));

        // 再次模拟冷却期到期，应该能放行新一轮探针
        SimulateExpiredCooldown(tracker, EndpointId);
        Assert.True(tracker.IsAvailable(EndpointId), "新一轮冷却期到期后应放行新探针");
    }

    // ─── 并发场景（多线程同时检查）──────────────────────────────────

    [Fact]
    public void HalfOpen_ConcurrentRequests_ExactlyOneProbePasses()
    {
        // 模拟 100 个并发请求同时到达，只有 1 个应被放行
        var tracker = new PoolHealthTracker { UnavailableThreshold = 1, HalfOpenCooldownSeconds = 1 };
        tracker.RecordFailure(EndpointId);
        SimulateExpiredCooldown(tracker, EndpointId);

        const int concurrentCount = 100;
        var results = new bool[concurrentCount];

        Parallel.For(0, concurrentCount, i =>
        {
            results[i] = tracker.IsAvailable(EndpointId);
        });

        int allowedCount = results.Count(r => r);
        Assert.Equal(1, allowedCount);
    }

    // ─── 状态指标测试 ─────────────────────────────────────────────

    [Fact]
    public void RecordSuccess_ResetsConsecutiveFailures()
    {
        var tracker = new PoolHealthTracker { DegradeThreshold = 2, UnavailableThreshold = 5 };
        tracker.RecordFailure(EndpointId);
        tracker.RecordFailure(EndpointId);
        tracker.RecordSuccess(EndpointId, 100);

        Assert.Equal(0, tracker.GetConsecutiveFailures(EndpointId));
        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus(EndpointId));
    }

    [Fact]
    public void GetHealthScore_Healthy_Returns100()
    {
        var tracker = new PoolHealthTracker();
        tracker.RecordSuccess(EndpointId, 100);
        Assert.Equal(100, tracker.GetHealthScore(EndpointId));
    }

    [Fact]
    public void GetHealthScore_Unavailable_Returns0()
    {
        var tracker = new PoolHealthTracker { UnavailableThreshold = 1 };
        tracker.RecordFailure(EndpointId);
        Assert.Equal(0, tracker.GetHealthScore(EndpointId));
    }

    [Fact]
    public void ResetHealth_MakesEndpointHealthy()
    {
        var tracker = new PoolHealthTracker { UnavailableThreshold = 1 };
        tracker.RecordFailure(EndpointId);
        Assert.Equal(EndpointHealthStatus.Unavailable, tracker.GetStatus(EndpointId));

        tracker.ResetHealth(EndpointId);
        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus(EndpointId));
        Assert.True(tracker.IsAvailable(EndpointId));
    }

    [Fact]
    public void ResetAll_MakesAllEndpointsHealthy()
    {
        var tracker = new PoolHealthTracker { UnavailableThreshold = 1 };
        tracker.RecordFailure("ep-1");
        tracker.RecordFailure("ep-2");
        tracker.RecordFailure("ep-3");

        tracker.ResetAll();

        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus("ep-1"));
        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus("ep-2"));
        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus("ep-3"));
    }

    [Fact]
    public void GetAverageLatency_ReturnsCorrectAverage()
    {
        var tracker = new PoolHealthTracker { LatencyWindowSize = 5 };
        tracker.RecordSuccess(EndpointId, 100);
        tracker.RecordSuccess(EndpointId, 200);
        tracker.RecordSuccess(EndpointId, 300);

        var avg = tracker.GetAverageLatencyMs(EndpointId);
        Assert.Equal(200.0, avg, precision: 1);
    }

    [Fact]
    public void LatencyWindow_ExceedsCapacity_OldestDropped()
    {
        var tracker = new PoolHealthTracker { LatencyWindowSize = 3 };
        tracker.RecordSuccess(EndpointId, 1000); // 会被淘汰
        tracker.RecordSuccess(EndpointId, 100);
        tracker.RecordSuccess(EndpointId, 200);
        tracker.RecordSuccess(EndpointId, 300); // 此时窗口 = [100, 200, 300]

        var avg = tracker.GetAverageLatencyMs(EndpointId);
        Assert.Equal(200.0, avg, precision: 1);
    }

    // ─── 辅助方法 ─────────────────────────────────────────────────

    /// <summary>
    /// 通过反射将端点的 LastFailedAt 设置为足够早的时间，模拟冷却期已到期。
    /// 必须在 RecordFailure 之后调用（确保字典中已有该端点的条目）。
    /// </summary>
    private static void SimulateExpiredCooldown(PoolHealthTracker tracker, string endpointId)
    {
        // 1. 获取私有字段 _health（ConcurrentDictionary<string, EndpointHealth>）
        var healthField = typeof(PoolHealthTracker)
            .GetField("_health", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;

        var dict = healthField.GetValue(tracker)!; // object，实际是 ConcurrentDictionary<string, EndpointHealth>

        // 2. 通过反射调用 TryGetValue（避免因内部类型不可见无法直接强转）
        var tryGetValue = dict.GetType().GetMethod("TryGetValue")!;
        var args = new object?[] { endpointId, null };
        bool found = (bool)tryGetValue.Invoke(dict, args)!;
        if (!found) return;

        var healthObj = args[1]!; // EndpointHealth 实例

        // 3. 设置 LastFailedAt 为 1 小时前，确保任何冷却期都已到期
        var lastFailedAtField = healthObj.GetType()
            .GetField("LastFailedAt", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance)!;

        lastFailedAtField.SetValue(healthObj, (DateTime?)DateTime.UtcNow.AddHours(-1));
    }
}
