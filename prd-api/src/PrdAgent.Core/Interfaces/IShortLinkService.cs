using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 统一短链服务 — 负责数字 Seq ↔ (TargetType, TargetId) 的双向映射。
/// 所有需要短链 URL（/s/{seq}）的分享系统都应通过本服务分配。
/// </summary>
public interface IShortLinkService
{
    /// <summary>
    /// 为 (targetType, targetId) 分配短链 Seq。
    /// 同一资源重复调用返回已有 Seq（幂等）。
    /// </summary>
    Task<long> AllocateAsync(string targetType, string targetId, CancellationToken ct = default);

    /// <summary>按 Seq 反查 ShortLink 路由记录。</summary>
    Task<ShortLink?> ResolveAsync(long seq, CancellationToken ct = default);

    /// <summary>
    /// 管理员视角：分页列出所有短链。targetType / search 可选。
    /// search 是纯数字时按 Seq 精确匹配，否则按 TargetId 包含匹配。
    /// </summary>
    Task<(IReadOnlyList<ShortLink> Items, long Total)> ListAsync(
        string? targetType, string? search, int skip, int limit, CancellationToken ct = default);

    /// <summary>
    /// 把全局 counter.seq 单调对齐到 max(seq)；用于运维误删/误改 counter 后的快速恢复。
    /// </summary>
    Task<long> RepairCounterAsync(CancellationToken ct = default);
}
