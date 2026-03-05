using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Assets;

/// <summary>
/// 披露 PRD 文档（documents 集合，通过 sessions 关联到用户）
/// </summary>
public class PrdDocumentAssetProvider : IAssetProvider
{
    private readonly MongoDbContext _db;
    public PrdDocumentAssetProvider(MongoDbContext db) => _db = db;

    public string Source => "PRD Agent";
    public string[] SupportedCategories => ["document"];

    public async Task<List<UnifiedAsset>> GetAssetsAsync(string userId, int limit, CancellationToken ct)
    {
        // 通过 Session 反查用户拥有的文档
        var sessions = await _db.Sessions
            .Find(s => s.OwnerUserId == userId && s.DeletedAtUtc == null)
            .SortByDescending(s => s.LastActiveAt)
            .Limit(limit)
            .ToListAsync(ct);

        var docIds = sessions
            .Where(s => !string.IsNullOrEmpty(s.DocumentId))
            .Select(s => s.DocumentId)
            .Distinct()
            .ToList();

        if (docIds.Count == 0) return [];

        var docs = await _db.Documents
            .Find(d => docIds.Contains(d.Id))
            .ToListAsync(ct);

        return docs.Select(doc => new UnifiedAsset
        {
            Id = $"doc-{doc.Id}",
            Type = "document",
            Title = !string.IsNullOrEmpty(doc.Title) ? doc.Title : "PRD 文档",
            Summary = ExtractSummary(doc),
            Source = Source,
            Mime = "text/markdown",
            SizeBytes = doc.CharCount,
            CreatedAt = doc.CreatedAt,
        }).ToList();
    }

    private static string? ExtractSummary(PrdAgent.Core.Models.ParsedPrd doc)
    {
        // 优先取章节标题列表，否则取 RawContent 前80字
        if (doc.Sections is { Count: > 0 })
        {
            var titles = doc.Sections
                .Take(4)
                .Select(s => s.Title)
                .Where(t => !string.IsNullOrWhiteSpace(t));
            var joined = string.Join(" · ", titles);
            if (!string.IsNullOrEmpty(joined))
                return joined.Length <= 80 ? joined : joined[..80] + "…";
        }

        if (!string.IsNullOrWhiteSpace(doc.RawContent))
        {
            var clean = doc.RawContent.Replace("\n", " ").Replace("\r", "").Trim();
            return clean.Length <= 80 ? clean : clean[..80] + "…";
        }

        return $"{doc.CharCount} 字";
    }
}
