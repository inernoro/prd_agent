using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.DocumentStore;

/// <summary>
/// 双链账本服务：负责解析正文、写入 mentions 集合、查询反向链接、生成图谱数据。
///
/// MVP 范围（2026-06-11）：仅 document → document。
/// 标题解析：在同一 ScopeId（StoreId）内做精确匹配；匹配不到的链接不入账本，
/// 也不动正文（保持「正文是 SSOT」原则）。
/// </summary>
public class MentionService
{
    private readonly MongoDbContext _db;

    public MentionService(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// 重新同步某个文档条目的对外引用。
    /// 策略：先清掉这条条目作为 from 的所有 mentions，再按新正文重写。
    /// 即「保存时先删后写」—— 因为 mention 是正文的纯派生数据，没有合并问题。
    /// </summary>
    /// <returns>新写入的引用数</returns>
    public async Task<int> ResyncDocumentMentionsAsync(string storeId, string fromEntryId, string content, CancellationToken ct = default)
    {
        // 1. 删旧
        await _db.Mentions.DeleteManyAsync(
            m => m.FromType == MentionEntityType.Document && m.FromId == fromEntryId,
            ct);

        // 2. 解析 [[xxx]]
        var matches = WikiLinkParser.Parse(content);
        if (matches.Count == 0) return 0;

        // 3. 同库内按标题查 entryId（一次查询，O(N) 解析）
        // 注：标题去重 + 不区分大小写不在 MVP 范围；先用精确匹配
        var anchorTexts = matches.Select(m => m.AnchorText).Distinct().ToList();
        var candidates = await _db.DocumentEntries
            .Find(e => e.StoreId == storeId && anchorTexts.Contains(e.Title))
            .Project(e => new { e.Id, e.Title })
            .ToListAsync(ct);

        // 标题 → 第一个匹配的 entryId（同库内标题撞名时取最早创建的；MVP 不做歧义提示）
        var titleToId = candidates
            .GroupBy(c => c.Title)
            .ToDictionary(g => g.Key, g => g.First().Id);

        // 4. 写入新账本（去重 from+to 对）
        var rows = new List<Mention>();
        var seen = new HashSet<string>();
        foreach (var match in matches)
        {
            if (!titleToId.TryGetValue(match.AnchorText, out var toId)) continue;
            if (toId == fromEntryId) continue; // 自引用忽略
            var dedupKey = $"{fromEntryId}|{toId}";
            if (!seen.Add(dedupKey)) continue;

            rows.Add(new Mention
            {
                FromType = MentionEntityType.Document,
                FromId = fromEntryId,
                ToType = MentionEntityType.Document,
                ToId = toId,
                AnchorText = match.AnchorText,
                Context = match.Context,
                ScopeId = storeId,
                IsAutoDetected = false,
            });
        }

        if (rows.Count > 0)
        {
            await _db.Mentions.InsertManyAsync(rows, cancellationToken: ct);
        }
        return rows.Count;
    }

    /// <summary>查询"谁引用了我"（反向链接）。</summary>
    public async Task<List<Mention>> GetBacklinksAsync(string toType, string toId, CancellationToken ct = default)
    {
        return await _db.Mentions
            .Find(m => m.ToType == toType && m.ToId == toId)
            .SortByDescending(m => m.CreatedAt)
            .ToListAsync(ct);
    }

    /// <summary>查询"我引用了谁"（出链）。</summary>
    public async Task<List<Mention>> GetForwardLinksAsync(string fromType, string fromId, CancellationToken ct = default)
    {
        return await _db.Mentions
            .Find(m => m.FromType == fromType && m.FromId == fromId)
            .ToListAsync(ct);
    }

    /// <summary>
    /// 级联清理：某些实体被删除时调用，清掉以它为 from 或 to 的所有引用。
    /// MVP 文档删除场景：传入文档 entryId 列表。
    /// </summary>
    public async Task<long> CascadeDeleteAsync(string entityType, IReadOnlyCollection<string> entityIds, CancellationToken ct = default)
    {
        if (entityIds.Count == 0) return 0;
        var filter = Builders<Mention>.Filter.Or(
            Builders<Mention>.Filter.And(
                Builders<Mention>.Filter.Eq(m => m.FromType, entityType),
                Builders<Mention>.Filter.In(m => m.FromId, entityIds)),
            Builders<Mention>.Filter.And(
                Builders<Mention>.Filter.Eq(m => m.ToType, entityType),
                Builders<Mention>.Filter.In(m => m.ToId, entityIds)));
        var r = await _db.Mentions.DeleteManyAsync(filter, ct);
        return r.DeletedCount;
    }

    /// <summary>
    /// 查询某知识库的全图：返回所有库内文档之间的引用关系（用于宇宙图渲染）。
    /// </summary>
    public async Task<List<Mention>> GetStoreGraphAsync(string storeId, CancellationToken ct = default)
    {
        return await _db.Mentions
            .Find(m => m.ScopeId == storeId)
            .ToListAsync(ct);
    }
}
