using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 消息仓储接口（用于持久化与查询）
/// </summary>
public interface IMessageRepository
{
    Task InsertManyAsync(IEnumerable<Message> messages);
}


