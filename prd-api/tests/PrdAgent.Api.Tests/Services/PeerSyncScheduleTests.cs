using System;
using PrdAgent.Api.Services.PeerSync;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 知识库自动同步「到期判定」的守卫测试 —— 这是防风暴的第一道闸：
/// 只有「开启 + 有可复用对端 + 不在跑 + 到期」的库才会被 worker 捞起来。
/// </summary>
public class PeerSyncScheduleTests
{
    private static DocumentStore Synced(bool autoEnabled, DateTime? autoLastAt, int? interval = null, string? status = "synced")
        => new()
        {
            PeerSyncAutoEnabled = autoEnabled,
            PeerSyncNodeId = "remote-node-1",
            PeerSyncDirection = "both",
            PeerSyncStatus = status,
            PeerSyncAutoLastAt = autoLastAt,
            PeerSyncIntervalMinutes = interval,
            PeerSyncAutoMode = PeerSyncSchedule.ScheduledMode,
        };

    [Fact]
    public void NotEnabled_IsNeverDue()
    {
        var store = Synced(autoEnabled: false, autoLastAt: null);
        Assert.False(PeerSyncSchedule.IsDue(store, DateTime.UtcNow));
    }

    [Fact]
    public void Enabled_NeverSyncedYet_IsDueImmediately()
    {
        var store = Synced(autoEnabled: true, autoLastAt: null);
        Assert.True(PeerSyncSchedule.IsDue(store, DateTime.UtcNow));
    }

    [Fact]
    public void Enabled_ButNoPeerNode_IsNotDue()
    {
        var store = Synced(autoEnabled: true, autoLastAt: null);
        store.PeerSyncNodeId = null; // 从没成功手动同步过 → 自动同步无从下手
        Assert.False(PeerSyncSchedule.IsDue(store, DateTime.UtcNow));
    }

    [Fact]
    public void Enabled_ButReceivedDirection_IsNotDue()
    {
        var store = Synced(autoEnabled: true, autoLastAt: null);
        store.PeerSyncDirection = "received"; // 仅接收审计，不是用户确认过的自动同步方向
        Assert.False(PeerSyncSchedule.IsDue(store, DateTime.UtcNow));
        Assert.Null(PeerSyncSchedule.GetNextSyncAt(store));
    }

    [Fact]
    public void Enabled_StaleSyncingStatus_StillDue_LeaseHandlesInflight()
    {
        // 进程崩溃残留 status=syncing 不应永久禁用自动同步：在途互斥交给租约（有 TTL 自愈），
        // IsDue 只按周期判到期。到期 + 残留 syncing → 仍可被捞起（Bugbot High 回归守卫）。
        var now = DateTime.UtcNow;
        var store = Synced(autoEnabled: true, autoLastAt: now.AddMinutes(-61), interval: 60, status: "syncing");
        Assert.True(PeerSyncSchedule.IsDue(store, now));
    }

    [Fact]
    public void Enabled_WithinInterval_IsNotDue()
    {
        var now = DateTime.UtcNow;
        var store = Synced(autoEnabled: true, autoLastAt: now.AddMinutes(-30), interval: 60);
        Assert.False(PeerSyncSchedule.IsDue(store, now));
    }

    [Fact]
    public void Enabled_PastInterval_IsDue()
    {
        var now = DateTime.UtcNow;
        var store = Synced(autoEnabled: true, autoLastAt: now.AddMinutes(-61), interval: 60);
        Assert.True(PeerSyncSchedule.IsDue(store, now));
    }

    [Theory]
    [InlineData(null, 60)]   // 缺省 → 默认 60
    [InlineData(0, 5)]       // 0 → 夹到下限 5
    [InlineData(1, 5)]       // 低于下限 → 夹到 5（防高频轰炸对端）
    [InlineData(5, 5)]
    [InlineData(120, 120)]
    public void ClampInterval_FloorAndDefault(int? input, int expected)
    {
        Assert.Equal(expected, PeerSyncSchedule.ClampInterval(input));
    }

    [Fact]
    public void ClampInterval_FloorAppliesToDueGating()
    {
        // 即便用户填了 1 分钟，到期判定也按 5 分钟下限算：上次 2 分钟前 → 还没到期。
        var now = DateTime.UtcNow;
        var store = Synced(autoEnabled: true, autoLastAt: now.AddMinutes(-2), interval: 1);
        Assert.False(PeerSyncSchedule.IsDue(store, now));
    }

    [Fact]
    public void TriggerMode_UsesShortDebounceInsteadOfScheduledInterval()
    {
        var now = DateTime.UtcNow;
        var store = Synced(autoEnabled: true, autoLastAt: now.AddMinutes(-3), interval: 1440);
        store.PeerSyncAutoMode = PeerSyncSchedule.TriggerMode;
        store.UpdatedAt = now.AddMinutes(-3);
        Assert.True(PeerSyncSchedule.IsDue(store, now));
    }

    [Fact]
    public void TriggerMode_CombinesRapidChanges()
    {
        var now = DateTime.UtcNow;
        var store = Synced(autoEnabled: true, autoLastAt: now.AddMinutes(-1), interval: 5);
        store.PeerSyncAutoMode = PeerSyncSchedule.TriggerMode;
        Assert.False(PeerSyncSchedule.IsDue(store, now));
    }

    [Fact]
    public void TriggerMode_WaitsForQuietWindowAfterLatestContentChange()
    {
        var now = DateTime.UtcNow;
        var store = Synced(autoEnabled: true, autoLastAt: now.AddMinutes(-10), interval: 5);
        store.PeerSyncAutoMode = PeerSyncSchedule.TriggerMode;
        store.UpdatedAt = now.AddSeconds(-30);
        Assert.False(PeerSyncSchedule.IsDue(store, now));
    }

    [Theory]
    [InlineData(null, "trigger")]
    [InlineData("unknown", "trigger")]
    [InlineData("trigger", "trigger")]
    [InlineData("scheduled", "scheduled")]
    public void NormalizeMode_DefaultsToTrigger(string? input, string expected)
    {
        Assert.Equal(expected, PeerSyncSchedule.NormalizeMode(input));
    }

    [Theory]
    // 归一方向 → 含对齐等价值的集合
    [InlineData("push", new[] { "push", "align-local" })]
    [InlineData("pull", new[] { "pull", "align-remote" })]
    [InlineData("both", new[] { "both", "align-both" })]
    // align-* 原值也必须归一到同一集合：store.PeerSyncDirection 被 IsRunnableDirection /
    // IsUserConfirmedAutoDirection 视为合法可运行值也含 align-*，若这里返回空集，established gate
    // 会把「用强制对齐建立过」的库误判为未建立、禁掉自动同步（Codex PR#1144 P2 回归守卫）。
    [InlineData("align-local", new[] { "push", "align-local" })]
    [InlineData("align-remote", new[] { "pull", "align-remote" })]
    [InlineData("align-both", new[] { "both", "align-both" })]
    public void AcceptableRunDirections_NormalizesAlignEquivalents(string? input, string[] expected)
    {
        Assert.Equal(expected, PeerSyncSchedule.AcceptableRunDirections(input));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("received")]   // 仅接收审计，不算任何可运行方向
    [InlineData("unknown")]
    public void AcceptableRunDirections_EmptyForNonRunnable(string? input)
    {
        Assert.Empty(PeerSyncSchedule.AcceptableRunDirections(input));
    }
}
