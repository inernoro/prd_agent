using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Assets;

/// <summary>
/// 披露用户的托管网页站点（hosted_sites 集合）为统一资产。
/// </summary>
public class WebPageAssetProvider : IAssetProvider
{
    private readonly MongoDbContext _db;
    public WebPageAssetProvider(MongoDbContext db) => _db = db;

    public string Source => "网页托管";
    public string[] SupportedCategories => ["webpage"];

    public async Task<List<UnifiedAsset>> GetAssetsAsync(string userId, int limit, CancellationToken ct)
    {
        var sites = await _db.HostedSites
            .Find(s => s.OwnerUserId == userId)
            .SortByDescending(s => s.CreatedAt)
            .Limit(limit)
            .ToListAsync(ct);

        return sites.Select(s => new UnifiedAsset
        {
            Id = $"wp-{s.Id}",
            Type = "webpage",
            Title = s.Title,
            Summary = FormatSummary(s),
            Source = Source,
            Url = s.SiteUrl,
            ThumbnailUrl = s.CoverImageUrl,
            Mime = "text/html",
            SizeBytes = s.TotalSize,
            CreatedAt = s.CreatedAt,
        }).ToList();
    }

    private static string FormatSummary(PrdAgent.Core.Models.HostedSite s)
    {
        var fileCount = s.Files?.Count ?? 0;
        var size = s.TotalSize switch
        {
            < 1024 => $"{s.TotalSize} B",
            < 1024 * 1024 => $"{s.TotalSize / 1024.0:F1} KB",
            _ => $"{s.TotalSize / (1024.0 * 1024.0):F1} MB",
        };
        return $"{fileCount} 个文件 · {size}";
    }
}
