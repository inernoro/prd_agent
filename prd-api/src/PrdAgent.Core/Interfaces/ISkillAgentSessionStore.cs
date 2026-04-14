using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// SkillAgent 会话持久化仓储。
/// 设计：内存做热缓存，MongoDB 做源头真相——进程重启、2h 过期、用户刷新都能恢复。
/// 所有方法均带 userId 过滤以杜绝跨用户访问。
/// </summary>
public interface ISkillAgentSessionStore
{
    /// <summary>按 sessionId + userId 加载会话（跨用户返回 null）</summary>
    Task<SkillAgentSession?> LoadAsync(string sessionId, string userId, CancellationToken ct = default);

    /// <summary>
    /// 以 (Id, UserId) 为过滤键做 upsert。并发语义：最后写入者胜。
    /// 实现必须不抛异常（持久化失败不应打断 SSE 流），失败时通过日志体现。
    /// </summary>
    Task SaveAsync(SkillAgentSession session, CancellationToken ct = default);

    /// <summary>删除会话记录（用户点"重置"时调用）</summary>
    Task DeleteAsync(string sessionId, string userId, CancellationToken ct = default);
}
