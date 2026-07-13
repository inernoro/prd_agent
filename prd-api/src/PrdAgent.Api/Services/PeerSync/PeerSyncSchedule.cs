using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.PeerSync;

/// <summary>
/// 知识库自动同步的到期判定（纯函数，便于单测）。
/// 防风暴的第一道闸：只有「已显式开启 + 有可复用对端 + 到期」的库才会被 worker 捞起来。
/// </summary>
public static class PeerSyncSchedule
{
    /// <summary>自动同步周期下限 —— 即便用户填更小的值也会被夹到这里，避免高频轰炸对端。</summary>
    public const int MinIntervalMinutes = 5;

    /// <summary>用户未指定周期时的默认值。</summary>
    public const int DefaultIntervalMinutes = 60;

    /// <summary>变更触发模式的合并窗口。短时间连续保存只触发一轮，避免逐次编辑形成发送风暴。</summary>
    public const int TriggerDebounceMinutes = 2;

    public const string TriggerMode = "trigger";
    public const string ScheduledMode = "scheduled";

    public static string NormalizeMode(string? mode)
        => string.Equals(mode, ScheduledMode, StringComparison.OrdinalIgnoreCase) ? ScheduledMode : TriggerMode;

    /// <summary>把用户填写的周期夹到 [MinIntervalMinutes, +∞)，null 回落默认值。</summary>
    public static int ClampInterval(int? minutes)
    {
        var v = minutes ?? DefaultIntervalMinutes;
        return v < MinIntervalMinutes ? MinIntervalMinutes : v;
    }

    /// <summary>自动同步只接受用户主动确认过的方向；received 只是接收审计，不能被 worker 捞起。</summary>
    public static bool IsRunnableDirection(string? direction) => direction switch
    {
        "push" or "pull" or "both" or "align-remote" or "align-local" or "align-both" => true,
        _ => false,
    };

    /// <summary>
    /// 该库当前是否「该自动同步了」。要求：
    /// 1) 已显式开启自动同步；
    /// 2) 上一轮已结束（不是 syncing 状态，避免叠跑）；
    /// 3) 有可复用的对端节点 + 方向（最近手动同步过一次留下的）；
    /// 4) 距上次自动同步已超过周期（首次 PeerSyncAutoLastAt 为空 = 立即可同步）。
    /// </summary>
    public static bool IsDue(DocumentStore store, DateTime utcNow)
    {
        if (!store.PeerSyncAutoEnabled)
            return false;

        // 没有可复用的对端 / 方向（从没成功手动同步过）→ 自动同步无从下手，跳过。
        if (string.IsNullOrWhiteSpace(store.PeerSyncNodeId) || !IsRunnableDirection(store.PeerSyncDirection))
            return false;

        // 不再用 PeerSyncStatus=="syncing" 判在途 —— 进程在置 syncing 后崩溃会把状态永久卡在 syncing，
        // 导致该库自动同步被永久禁用（Bugbot High: Stale syncing blocks auto forever）。
        // 互斥与在途检测改由「租约」承担：worker 抢 TryAcquireStoreSyncLeaseAsync 才会真正跑，
        // 租约有 TTL 会自愈；这里只按周期判到期，candidate 即使在途也会在抢租约阶段被挡掉。

        if (store.PeerSyncAutoLastAt == null)
            return true;

        var triggerMode = NormalizeMode(store.PeerSyncAutoMode) == TriggerMode;
        var interval = triggerMode
            ? TriggerDebounceMinutes
            : ClampInterval(store.PeerSyncIntervalMinutes);
        if (store.PeerSyncAutoLastAt.Value.AddMinutes(interval) > utcNow)
            return false;

        // 触发模式还要从知识库最近一次实际变更起等待完整合并窗口，避免用户连续保存时中途发送。
        // 定时模式只遵循配置周期。
        return !triggerMode || store.UpdatedAt.AddMinutes(TriggerDebounceMinutes) <= utcNow;
    }

    /// <summary>下一次自动同步的预计时间（UI 展示用）。未开启 / 无对端时为 null。</summary>
    public static DateTime? GetNextSyncAt(DocumentStore store)
    {
        if (!store.PeerSyncAutoEnabled
            || string.IsNullOrWhiteSpace(store.PeerSyncNodeId)
            || !IsRunnableDirection(store.PeerSyncDirection))
            return null;

        if (store.PeerSyncAutoLastAt == null)
            return null; // 立即可同步

        var triggerMode = NormalizeMode(store.PeerSyncAutoMode) == TriggerMode;
        var interval = triggerMode ? TriggerDebounceMinutes : ClampInterval(store.PeerSyncIntervalMinutes);
        var next = store.PeerSyncAutoLastAt.Value.AddMinutes(interval);
        if (triggerMode)
        {
            var quietAt = store.UpdatedAt.AddMinutes(TriggerDebounceMinutes);
            if (quietAt > next) next = quietAt;
        }
        return next;
    }
}
