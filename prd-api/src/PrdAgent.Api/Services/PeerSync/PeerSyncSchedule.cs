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

    /// <summary>把用户填写的周期夹到 [MinIntervalMinutes, +∞)，null 回落默认值。</summary>
    public static int ClampInterval(int? minutes)
    {
        var v = minutes ?? DefaultIntervalMinutes;
        return v < MinIntervalMinutes ? MinIntervalMinutes : v;
    }

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
        if (string.IsNullOrWhiteSpace(store.PeerSyncNodeId) || string.IsNullOrWhiteSpace(store.PeerSyncDirection))
            return false;

        // 上一轮还在跑（manual 或 auto）→ 不叠跑。
        if (string.Equals(store.PeerSyncStatus, "syncing", StringComparison.Ordinal))
            return false;

        if (store.PeerSyncAutoLastAt == null)
            return true;

        var interval = ClampInterval(store.PeerSyncIntervalMinutes);
        return store.PeerSyncAutoLastAt.Value.AddMinutes(interval) <= utcNow;
    }

    /// <summary>下一次自动同步的预计时间（UI 展示用）。未开启 / 无对端时为 null。</summary>
    public static DateTime? GetNextSyncAt(DocumentStore store)
    {
        if (!store.PeerSyncAutoEnabled
            || string.IsNullOrWhiteSpace(store.PeerSyncNodeId)
            || string.IsNullOrWhiteSpace(store.PeerSyncDirection))
            return null;

        if (store.PeerSyncAutoLastAt == null)
            return null; // 立即可同步

        return store.PeerSyncAutoLastAt.Value.AddMinutes(ClampInterval(store.PeerSyncIntervalMinutes));
    }
}
