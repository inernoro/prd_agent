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

    /// <summary>按 (targetType, targetId) 查询已分配的 Seq；未分配返回 null。</summary>
    Task<long?> FindSeqAsync(string targetType, string targetId, CancellationToken ct = default);
}
