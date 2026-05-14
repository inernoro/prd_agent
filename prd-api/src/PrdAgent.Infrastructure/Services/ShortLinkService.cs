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

        // 计数器若被运维误删 / 误改导致落后于已用 seq，第一次插入会撞 unique index
        // (Seq)，我们最多重试 16 次：每轮 $inc +1 跳过已占用的 seq。如果仍失败，说明 counter
        // 偏离过远（>16），交给修复链路 RepairCounterAsync 一次性同步到 max(seq)+1 后再试一次。
        const int maxRetries = 16;
        for (int attempt = 0; attempt < maxRetries; attempt++)
        {
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
                return seq;
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // 优先判断是不是 (TargetType, TargetId) 并发竞态命中 — 直接复用已有 seq
                var dupeByTarget = await _links.Find(x => x.TargetType == tt && x.TargetId == tid).FirstOrDefaultAsync(ct);
                if (dupeByTarget != null)
                {
                    _logger.LogInformation("ShortLink 并发命中 {Type}/{Id} seq={Seq}", tt, tid, dupeByTarget.Seq);
                    return dupeByTarget.Seq;
                }
                // 否则是 Seq 撞车（counter 落后），继续重试
                _logger.LogWarning("ShortLink seq={Seq} 已被占用（counter 落后），第 {Attempt} 次重试", seq, attempt + 1);
            }
        }

        // 重试用完仍失败 → 同步 counter 到 max(seq)+1 后最后再试一次
        await RepairCounterAsync(ct);
        var finalCounter = await _counters.FindOneAndUpdateAsync(
            Builders<ShortLinkCounter>.Filter.Eq(x => x.Id, GlobalCounterKey),
            Builders<ShortLinkCounter>.Update.Inc(x => x.Seq, 1),
            new FindOneAndUpdateOptions<ShortLinkCounter>
            {
                IsUpsert = true,
                ReturnDocument = ReturnDocument.After,
            },
            ct);
        var finalSeq = finalCounter?.Seq > 0 ? finalCounter.Seq : 1;
        try
        {
            await _links.InsertOneAsync(new ShortLink
            {
                Seq = finalSeq,
                TargetType = tt,
                TargetId = tid,
            }, cancellationToken: ct);
            _logger.LogWarning("ShortLink 经 counter 修复后分配 seq={Seq}", finalSeq);
            return finalSeq;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 极端并发：两个 caller 同时为同一 (tt, tid) 走到 repair 末端，先到的赢，
            // 后到的撞 (TargetType, TargetId) 唯一索引 → 直接返回赢家的 seq 保持幂等。
            // 若 seq 维度撞（更罕见），说明仍有 counter 落后于真实 max，但此处不再
            // 二次 repair（避免无限循环），让异常往上抛由调用方观察告警。
            var winner = await _links.Find(x => x.TargetType == tt && x.TargetId == tid).FirstOrDefaultAsync(ct);
            if (winner != null)
            {
                _logger.LogWarning("ShortLink repair 末端并发命中 {Type}/{Id}，复用 winner seq={Seq}",
                    tt, tid, winner.Seq);
                return winner.Seq;
            }
            throw;
        }
    }

    /// <summary>
    /// 把全局 counter.seq 同步到当前 short_links 集合的 max(seq)；
    /// 用于运维误删 / 误改 counter 后的快速恢复。
    /// </summary>
    public async Task<long> RepairCounterAsync(CancellationToken ct = default)
    {
        var maxDoc = await _links
            .Find(FilterDefinition<ShortLink>.Empty)
            .Sort(Builders<ShortLink>.Sort.Descending(x => x.Seq))
            .Limit(1)
            .FirstOrDefaultAsync(ct);
        var maxSeq = maxDoc?.Seq ?? 0;

        await _counters.FindOneAndUpdateAsync(
            Builders<ShortLinkCounter>.Filter.Eq(x => x.Id, GlobalCounterKey),
            Builders<ShortLinkCounter>.Update.Set(x => x.Seq, maxSeq),
            new FindOneAndUpdateOptions<ShortLinkCounter> { IsUpsert = true },
            ct);
        _logger.LogWarning("ShortLinkCounter 已修复同步到 seq={MaxSeq}", maxSeq);
        return maxSeq;
    }

    public async Task<(IReadOnlyList<ShortLink> Items, long Total)> ListAsync(
        string? targetType,
        string? search,
        int skip,
        int limit,
        CancellationToken ct = default)
    {
        if (limit <= 0 || limit > 200) limit = 50;
        if (skip < 0) skip = 0;

        var filters = new List<FilterDefinition<ShortLink>>();
        if (!string.IsNullOrWhiteSpace(targetType))
            filters.Add(Builders<ShortLink>.Filter.Eq(x => x.TargetType, targetType.Trim()));
        if (!string.IsNullOrWhiteSpace(search))
        {
            var s = search.Trim();
            // 纯数字按 Seq 等值匹配；否则按 TargetId 包含
            if (long.TryParse(s, out var seqQuery))
                filters.Add(Builders<ShortLink>.Filter.Eq(x => x.Seq, seqQuery));
            else
                filters.Add(Builders<ShortLink>.Filter.Regex(x => x.TargetId,
                    new MongoDB.Bson.BsonRegularExpression(System.Text.RegularExpressions.Regex.Escape(s), "i")));
        }
        var filter = filters.Count == 0 ? FilterDefinition<ShortLink>.Empty : Builders<ShortLink>.Filter.And(filters);

        var total = await _links.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _links.Find(filter)
            .Sort(Builders<ShortLink>.Sort.Descending(x => x.Seq))
            .Skip(skip).Limit(limit)
            .ToListAsync(ct);
        return (items, total);
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
