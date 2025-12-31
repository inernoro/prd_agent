using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 群消息顺序号生成（Mongo 原子自增）。
/// </summary>
public class GroupMessageSeqService : IGroupMessageSeqService
{
    private readonly IMongoCollection<GroupMessageCounter> _counters;

    public GroupMessageSeqService(IMongoCollection<GroupMessageCounter> counters)
    {
        _counters = counters;
    }

    public async Task<long> NextAsync(string groupId, CancellationToken cancellationToken = default)
    {
        var gid = (groupId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(gid))
            throw new ArgumentException("groupId 不能为空", nameof(groupId));

        var filter = Builders<GroupMessageCounter>.Filter.Eq(x => x.GroupId, gid);
        var update = Builders<GroupMessageCounter>.Update.Inc(x => x.Seq, 1);

        var options = new FindOneAndUpdateOptions<GroupMessageCounter>
        {
            IsUpsert = true,
            ReturnDocument = ReturnDocument.After
        };

        var doc = await _counters.FindOneAndUpdateAsync(
            filter,
            update,
            options,
            cancellationToken);

        // upsert 场景下理论上不会为 null；兜底一下
        if (doc == null) return 1;
        return doc.Seq <= 0 ? 1 : doc.Seq;
    }
}


