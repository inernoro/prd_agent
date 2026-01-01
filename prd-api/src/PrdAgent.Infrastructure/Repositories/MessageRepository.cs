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

    public async Task<Message?> FindByIdAsync(string messageId, bool includeDeleted = false)
    {
        var id = (messageId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(id)) return null;

        var fb = Builders<Message>.Filter;
        var filter = fb.Eq(x => x.Id, id);
        if (!includeDeleted)
        {
            filter &= fb.Ne(x => x.IsDeleted, true);
        }

        return await _messages.Find(filter).FirstOrDefaultAsync();
    }

    public async Task<List<Message>> FindByReplyToMessageIdAsync(string replyToMessageId, bool includeDeleted = false)
    {
        var rid = (replyToMessageId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(rid)) return new List<Message>();

        var fb = Builders<Message>.Filter;
        var filter = fb.Eq(x => x.ReplyToMessageId, rid);
        if (!includeDeleted)
        {
            filter &= fb.Ne(x => x.IsDeleted, true);
        }

        return await _messages
            .Find(filter)
            .SortBy(x => x.GroupSeq)
            .ThenBy(x => x.Timestamp)
            .ThenBy(x => x.Id)
            .ToListAsync();
    }

    public async Task<Message?> SoftDeleteAsync(string messageId, string deletedByUserId, string? reason, DateTime deletedAtUtc)
    {
        var id = (messageId ?? string.Empty).Trim();
        var by = (deletedByUserId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(by)) return null;

        var now = deletedAtUtc.Kind == DateTimeKind.Utc ? deletedAtUtc : deletedAtUtc.ToUniversalTime();

        var fb = Builders<Message>.Filter;
        var filter = fb.Eq(x => x.Id, id) & fb.Ne(x => x.IsDeleted, true);

        var ub = Builders<Message>.Update;
        var update = ub
            .Set(x => x.IsDeleted, true)
            .Set(x => x.DeletedAtUtc, now)
            .Set(x => x.DeletedByUserId, by)
            .Set(x => x.DeleteReason, string.IsNullOrWhiteSpace(reason) ? null : reason!.Trim());

        return await _messages.FindOneAndUpdateAsync(
            filter,
            update,
            new FindOneAndUpdateOptions<Message>
            {
                IsUpsert = false,
                ReturnDocument = ReturnDocument.After
            });
    }

    public async Task<List<Message>> FindBySessionAsync(string sessionId, DateTime? before, int limit)
    {
        var sid = (sessionId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(sid)) return new List<Message>();

        // 服务端保护：避免一次性拉太多导致内存/网络压力
        var take = Math.Clamp(limit, 1, 200);

        var fb = Builders<Message>.Filter;
        var filter = fb.Eq(x => x.SessionId, sid) & fb.Ne(x => x.IsDeleted, true);
        if (before.HasValue)
        {
            filter &= fb.Lt(x => x.Timestamp, before.Value);
        }

        // 注意：历史消息在“刷新加载”时必须保持与 SSE 回放一致的顺序。
        // 过去用 Role 作为二级排序，会在 Timestamp 大量相同（同一批写入/同一秒）时导致“按角色聚类”。
        // 因此优先使用 GroupSeq（若存在），否则退化为 Timestamp；并用 Id 作为最后兜底保证稳定性。
        //
        // Mongo LINQ3 不支持在 Sort 中使用 `x.GroupSeq.HasValue`，所以这里仅使用字段本身排序：
        // - Desc 排序下 null 会排在最后；Reverse 后 null 会出现在最前（与前端“缺失 groupSeq 放最前”的兼容策略一致）
        var list = await _messages
            .Find(filter)
            // 先取 desc（配合 before + limit），最后 Reverse 变为升序返回
            .SortByDescending(x => x.GroupSeq)
            .ThenByDescending(x => x.Timestamp)
            .ThenByDescending(x => x.Id)
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
        var filter = fb.Eq(x => x.GroupId, gid) & fb.Ne(x => x.IsDeleted, true);
        if (before.HasValue)
        {
            filter &= fb.Lt(x => x.Timestamp, before.Value);
        }

        // 优先用 groupSeq 保证“严格时序”（与 SSE 回放一致），避免 Timestamp 相同导致的角色聚类。
        // Mongo LINQ3 不支持在 Sort 中使用 `x.GroupSeq.HasValue`，所以这里只使用字段本身排序。
        var list = await _messages
            .Find(filter)
            // 先取 desc（配合 before + limit），最后 Reverse 变为升序返回
            .SortByDescending(x => x.GroupSeq)
            .ThenByDescending(x => x.Timestamp)
            .ThenByDescending(x => x.Id)
            .Limit(take)
            .ToListAsync();

        list.Reverse();
        return list;
    }

    public async Task<List<Message>> FindByGroupAfterSeqAsync(string groupId, long afterSeq, int limit)
    {
        var gid = (groupId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(gid)) return new List<Message>();

        var take = Math.Clamp(limit, 1, 200);
        var seq = Math.Max(0, afterSeq);

        var fb = Builders<Message>.Filter;
        var filter =
            fb.Eq(x => x.GroupId, gid) &
            fb.Ne(x => x.IsDeleted, true) &
            fb.Ne(x => x.GroupSeq, null) &
            fb.Gt(x => x.GroupSeq, seq);

        return await _messages
            .Find(filter)
            .SortBy(x => x.GroupSeq)
            .Limit(take)
            .ToListAsync();
    }

    public async Task<List<Message>> FindByGroupBeforeSeqAsync(string groupId, long beforeSeq, int limit)
    {
        var gid = (groupId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(gid)) return new List<Message>();

        var take = Math.Clamp(limit, 1, 200);
        var seq = Math.Max(1, beforeSeq); // beforeSeq <= 0 没有意义

        var fb = Builders<Message>.Filter;
        var filter =
            fb.Eq(x => x.GroupId, gid) &
            fb.Ne(x => x.IsDeleted, true) &
            fb.Ne(x => x.GroupSeq, null) &
            fb.Lt(x => x.GroupSeq, seq);

        // 先 desc 取 limit 条（最新的 N 条历史），再 reverse 成升序返回
        var list = await _messages
            .Find(filter)
            .SortByDescending(x => x.GroupSeq)
            .Limit(take)
            .ToListAsync();

        list.Reverse();
        return list;
    }
}


