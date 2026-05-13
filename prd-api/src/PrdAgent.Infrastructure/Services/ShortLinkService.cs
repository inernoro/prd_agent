using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 统一短链服务实现 — Mongo 原子自增 + 唯一索引兜底并发。
/// </summary>
public class ShortLinkService : IShortLinkService
{
    private const string GlobalCounterKey = "global";

    private readonly IMongoCollection<ShortLink> _links;
    private readonly IMongoCollection<ShortLinkCounter> _counters;
    private readonly ILogger<ShortLinkService> _logger;

    public ShortLinkService(MongoDbContext db, ILogger<ShortLinkService> logger)
    {
        _links = db.ShortLinks;
        _counters = db.ShortLinkCounters;
        _logger = logger;
    }

    public async Task<long> AllocateAsync(string targetType, string targetId, CancellationToken ct = default)
    {
        var tt = (targetType ?? string.Empty).Trim();
        var tid = (targetId ?? string.Empty).Trim();
        if (tt.Length == 0 || tid.Length == 0)
            throw new ArgumentException("targetType / targetId 不能为空");

        var existing = await _links.Find(x => x.TargetType == tt && x.TargetId == tid).FirstOrDefaultAsync(ct);
        if (existing != null) return existing.Seq;

        var counterDoc = await _counters.FindOneAndUpdateAsync(
            Builders<ShortLinkCounter>.Filter.Eq(x => x.Id, GlobalCounterKey),
            Builders<ShortLinkCounter>.Update.Inc(x => x.Seq, 1),
            new FindOneAndUpdateOptions<ShortLinkCounter>
            {
                IsUpsert = true,
                ReturnDocument = ReturnDocument.After,
            },
            ct);

        var seq = counterDoc?.Seq > 0 ? counterDoc.Seq : 1;

        try
        {
            await _links.InsertOneAsync(new ShortLink
            {
                Seq = seq,
                TargetType = tt,
                TargetId = tid,
            }, cancellationToken: ct);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            var dupe = await _links.Find(x => x.TargetType == tt && x.TargetId == tid).FirstOrDefaultAsync(ct);
            if (dupe != null)
            {
                _logger.LogInformation("ShortLink 并发竞态命中 {Type}/{Id} seq={Seq}", tt, tid, dupe.Seq);
                return dupe.Seq;
            }
            throw;
        }

        return seq;
    }

    public async Task<ShortLink?> ResolveAsync(long seq, CancellationToken ct = default)
    {
        if (seq <= 0) return null;
        return await _links.Find(x => x.Seq == seq).FirstOrDefaultAsync(ct);
    }

    public async Task<long?> FindSeqAsync(string targetType, string targetId, CancellationToken ct = default)
    {
        var doc = await _links.Find(x => x.TargetType == targetType && x.TargetId == targetId).FirstOrDefaultAsync(ct);
        return doc?.Seq;
    }
}
