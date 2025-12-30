using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 消息仓储接口（用于持久化与查询）
/// </summary>
public interface IMessageRepository
{
    Task InsertManyAsync(IEnumerable<Message> messages);

    /// <summary>
    /// 按会话分页查询消息（按时间升序返回）。
    /// </summary>
    /// <param name="sessionId">会话ID</param>
    /// <param name="before">可选：仅返回 Timestamp &lt; before 的更早消息</param>
    /// <param name="limit">返回条数（服务端会做保护）</param>
    Task<List<Message>> FindBySessionAsync(string sessionId, DateTime? before, int limit);

    /// <summary>
    /// 按群组分页查询消息（按时间升序返回）—— 用于客户端加载群组所有历史消息。
    /// </summary>
    /// <param name="groupId">群组ID</param>
    /// <param name="before">可选：仅返回 Timestamp &lt; before 的更早消息</param>
    /// <param name="limit">返回条数（服务端会做保护）</param>
    Task<List<Message>> FindByGroupAsync(string groupId, DateTime? before, int limit);
}


