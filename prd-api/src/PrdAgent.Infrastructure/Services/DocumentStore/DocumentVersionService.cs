using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.DocumentStore;

/// <summary>
/// 知识库文档版本控制服务：在独立集合 document_entry_versions 中保存每条文档的历史快照，
/// 支持列出历史、取回某版本正文、把当前内容快照成版本。
///
/// 安全性（吸取「文学创作版本导致图片丢失」教训）：
/// - 版本只存正文文本；知识库图片是 markdown 外链 URL，不是受管资产，恢复版本不删除任何资产；
/// - 版本是不可变快照（只新增不改）；
/// - 去重：与最新版本正文 hash 相同则不重复落库（github 无变化同步 / 重复保存不产生噪音版本）；
/// - 留存上限 <see cref="MaxVersionsPerEntry"/>，超出裁剪最旧（保留最近 N 条）。
/// </summary>
public class DocumentVersionService
{
    private readonly MongoDbContext _db;

    /// <summary>每条文档保留的最大历史版本数（超出裁剪最旧）。</summary>
    public const int MaxVersionsPerEntry = 100;

    public DocumentVersionService(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// 把一段正文快照成新版本。若与该 entry 最新版本正文一致则跳过（去重），返回 null。
    /// 否则落库并裁剪超额历史，返回新版本。
    /// </summary>
    public async Task<DocumentEntryVersion?> SnapshotAsync(
        string entryId,
        string storeId,
        string content,
        string source,
        string userId,
        string? userName,
        string? restoredFromVersionId = null,
        CancellationToken ct = default)
    {
        content ??= string.Empty;

        // 取最新版本，交给纯函数决策（是否去重 / 新版本号 / hash / 字节数）—— 便于单测覆盖
        var latest = await _db.DocumentEntryVersions
            .Find(v => v.EntryId == entryId)
            .SortByDescending(v => v.VersionNumber)
            .Limit(1)
            .FirstOrDefaultAsync(ct);

        var decision = DocumentVersionLogic.Decide(latest?.ContentHash, latest?.VersionNumber ?? 0, content);
        if (!decision.ShouldCreate)
            return null;

        var version = new DocumentEntryVersion
        {
            EntryId = entryId,
            StoreId = storeId,
            VersionNumber = decision.VersionNumber,
            Content = content,
            ContentHash = decision.Hash,
            CharCount = decision.CharCount,
            SizeBytes = decision.SizeBytes,
            Source = source,
            RestoredFromVersionId = restoredFromVersionId,
            CreatedBy = userId,
            CreatedByName = userName,
            CreatedAt = DateTime.UtcNow,
        };

        await _db.DocumentEntryVersions.InsertOneAsync(version, cancellationToken: ct);

        // 裁剪超额历史（保留最近 MaxVersionsPerEntry 条）
        await TrimAsync(entryId, ct);

        return version;
    }

    /// <summary>列出某条文档的历史版本（按版本号倒序，不含正文，分页）。</summary>
    public async Task<(List<DocumentEntryVersion> items, long total)> ListAsync(
        string entryId, int page, int pageSize, CancellationToken ct = default)
    {
        if (page < 1) page = 1;
        if (pageSize < 1) pageSize = 20;
        if (pageSize > 200) pageSize = 200;

        var filter = Builders<DocumentEntryVersion>.Filter.Eq(v => v.EntryId, entryId);
        var total = await _db.DocumentEntryVersions.CountDocumentsAsync(filter, cancellationToken: ct);

        // 列表场景不回传完整正文，省带宽（正文由「查看某版本」端点单取）
        var items = await _db.DocumentEntryVersions
            .Find(filter)
            // 次级按 CreatedAt 倒序：并发写入极端下若出现重复 VersionNumber，列表顺序仍确定（新插入在前），
            // 「最新」徽章不会落到随机一条。真正的单调唯一性需 DBA 在 (EntryId, VersionNumber) 建唯一索引，
            // 见 doc/guide.platform.mongodb-indexes.md（本仓库禁止应用自建索引）。
            .Sort(Builders<DocumentEntryVersion>.Sort
                .Descending(v => v.VersionNumber)
                .Descending(v => v.CreatedAt))
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .Project<DocumentEntryVersion>(Builders<DocumentEntryVersion>.Projection.Exclude(v => v.Content))
            .ToListAsync(ct);

        return (items, total);
    }

    /// <summary>取某个版本（含完整正文）。</summary>
    public async Task<DocumentEntryVersion?> GetAsync(string versionId, CancellationToken ct = default)
        => await _db.DocumentEntryVersions.Find(v => v.Id == versionId).FirstOrDefaultAsync(ct);

    /// <summary>统计某个空间所有版本占用的字节数（用于知识库大小统计）。</summary>
    public async Task<(long bytes, long count)> StoreVersionStatsAsync(string storeId, CancellationToken ct = default)
    {
        var versions = await _db.DocumentEntryVersions
            .Find(v => v.StoreId == storeId)
            .Project<DocumentEntryVersion>(Builders<DocumentEntryVersion>.Projection.Exclude(v => v.Content))
            .ToListAsync(ct);
        long bytes = 0;
        foreach (var v in versions) bytes += v.SizeBytes;
        return (bytes, versions.Count);
    }

    /// <summary>删除某条文档的全部版本（条目删除时级联清理）。</summary>
    public async Task DeleteForEntryAsync(string entryId, CancellationToken ct = default)
        => await _db.DocumentEntryVersions.DeleteManyAsync(v => v.EntryId == entryId, ct);

    private async Task TrimAsync(string entryId, CancellationToken ct)
    {
        var total = await _db.DocumentEntryVersions.CountDocumentsAsync(v => v.EntryId == entryId, cancellationToken: ct);
        if (total <= MaxVersionsPerEntry) return;

        var toRemove = (int)(total - MaxVersionsPerEntry);
        var oldest = await _db.DocumentEntryVersions
            .Find(v => v.EntryId == entryId)
            .SortBy(v => v.VersionNumber)
            .Limit(toRemove)
            .Project<DocumentEntryVersion>(Builders<DocumentEntryVersion>.Projection.Include(v => v.Id))
            .ToListAsync(ct);
        var ids = oldest.Select(v => v.Id).ToList();
        if (ids.Count > 0)
            await _db.DocumentEntryVersions.DeleteManyAsync(v => ids.Contains(v.Id), ct);
    }

    public static string ComputeSha256(string content)
    {
        using var sha = SHA256.Create();
        var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(content ?? string.Empty));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}

/// <summary>
/// 版本快照的纯决策逻辑（不依赖 Mongo，便于单元测试）。
/// 决定：与最新版本同 hash 则去重不落库；否则版本号 +1，并算好 hash / 字符数 / UTF-8 字节数。
/// </summary>
public static class DocumentVersionLogic
{
    public record SnapshotDecision(bool ShouldCreate, int VersionNumber, string Hash, int CharCount, long SizeBytes);

    public static SnapshotDecision Decide(string? latestHash, int latestNumber, string? content)
    {
        content ??= string.Empty;
        var hash = DocumentVersionService.ComputeSha256(content);
        var charCount = content.Length;
        var sizeBytes = Encoding.UTF8.GetByteCount(content);

        // 与最新版本内容一致 → 去重，不产生噪音版本（github 无变化同步 / 重复保存）
        if (latestHash != null && latestHash == hash)
            return new SnapshotDecision(false, latestNumber, hash, charCount, sizeBytes);

        return new SnapshotDecision(true, latestNumber + 1, hash, charCount, sizeBytes);
    }
}
