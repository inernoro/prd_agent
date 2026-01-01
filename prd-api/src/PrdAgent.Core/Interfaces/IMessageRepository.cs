using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 消息仓储接口（用于持久化与查询）
/// </summary>
public interface IMessageRepository
{
    Task InsertManyAsync(IEnumerable<Message> messages);

    /// <summary>
    /// 按消息ID获取单条消息（可选包含已删除）。
    /// </summary>
    Task<Message?> FindByIdAsync(string messageId, bool includeDeleted = false);

    /// <summary>
    /// 查找某条 User 消息所对应的 Assistant 回复（可选包含已删除）。
    /// </summary>
    Task<List<Message>> FindByReplyToMessageIdAsync(string replyToMessageId, bool includeDeleted = false);

    /// <summary>
    /// 软删除消息（用户态不可见），并返回更新后的消息快照。
    /// </summary>
    Task<Message?> SoftDeleteAsync(string messageId, string deletedByUserId, string? reason, DateTime deletedAtUtc);

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

    /// <summary>
    /// 按群组顺序号回放消息（严格按 GroupSeq 递增返回）：用于补洞/断线补拉。
    /// </summary>
    /// <param name="groupId">群组ID</param>
    /// <param name="afterSeq">仅返回 GroupSeq &gt; afterSeq 的消息</param>
    /// <param name="limit">返回条数（服务端会做保护）</param>
    Task<List<Message>> FindByGroupAfterSeqAsync(string groupId, long afterSeq, int limit);

    /// <summary>
    /// 按群组顺序号向前分页（严格按 GroupSeq 递减取 limit 条，最后升序返回）：用于历史分页加载。
    /// </summary>
    /// <param name="groupId">群组ID</param>
    /// <param name="beforeSeq">仅返回 GroupSeq &lt; beforeSeq 的消息</param>
    /// <param name="limit">返回条数（服务端会做保护）</param>
    Task<List<Message>> FindByGroupBeforeSeqAsync(string groupId, long beforeSeq, int limit);
}


