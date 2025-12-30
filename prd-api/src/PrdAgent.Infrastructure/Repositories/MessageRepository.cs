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

    public async Task<List<Message>> FindBySessionAsync(string sessionId, DateTime? before, int limit)
    {
        var sid = (sessionId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(sid)) return new List<Message>();

        // 服务端保护：避免一次性拉太多导致内存/网络压力
        var take = Math.Clamp(limit, 1, 200);

        var fb = Builders<Message>.Filter;
        var filter = fb.Eq(x => x.SessionId, sid);
        if (before.HasValue)
        {
            filter &= fb.Lt(x => x.Timestamp, before.Value);
        }

        var list = await _messages
            .Find(filter)
            .SortByDescending(x => x.Timestamp)
            .Limit(take)
            .ToListAsync();

        // API 侧约定：按时间升序返回，方便客户端 prepend/游标计算
        list.Reverse();
        return list;
    }

    public async Task<List<Message>> FindByGroupAsync(string groupId, DateTime? before, int limit)
    {
        var gid = (groupId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(gid)) return new List<Message>();

        var take = Math.Clamp(limit, 1, 200);

        var fb = Builders<Message>.Filter;
        var filter = fb.Eq(x => x.GroupId, gid);
        if (before.HasValue)
        {
            filter &= fb.Lt(x => x.Timestamp, before.Value);
        }

        var list = await _messages
            .Find(filter)
            .SortByDescending(x => x.Timestamp)
            .Limit(take)
            .ToListAsync();

        list.Reverse();
        return list;
    }
}


