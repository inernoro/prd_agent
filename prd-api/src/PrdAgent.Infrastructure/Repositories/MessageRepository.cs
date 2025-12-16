using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Repositories;

/// <summary>
/// 消息仓储实现（MongoDB）
/// </summary>
public class MessageRepository : IMessageRepository
{
    private readonly IMongoCollection<Message> _messages;

    public MessageRepository(IMongoCollection<Message> messages)
    {
        _messages = messages;
    }

    public async Task InsertManyAsync(IEnumerable<Message> messages)
    {
        var list = messages.ToList();
        if (list.Count == 0) return;
        await _messages.InsertManyAsync(list);
    }
}


