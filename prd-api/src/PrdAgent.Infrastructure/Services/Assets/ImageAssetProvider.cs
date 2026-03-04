using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Assets;

/// <summary>
/// 披露 AI 生成的图片资产（image_assets 集合）
/// </summary>
public class ImageAssetProvider : IAssetProvider
{
    private readonly MongoDbContext _db;
    public ImageAssetProvider(MongoDbContext db) => _db = db;

    public string Source => "视觉创作";
    public string[] SupportedCategories => ["image"];

    public async Task<List<UnifiedAsset>> GetAssetsAsync(string userId, int limit, CancellationToken ct)
    {
        var images = await _db.ImageAssets
            .Find(a => a.OwnerUserId == userId)
            .SortByDescending(a => a.CreatedAt)
            .Limit(limit)
            .ToListAsync(ct);

        return images.Select(img => new UnifiedAsset
        {
            Id = $"img-{img.Id}",
            Type = "image",
            Title = img.Prompt ?? "生成图片",
            Summary = Truncate(img.Prompt ?? img.Description, 80),
            Source = Source,
            Url = img.Url,
            ThumbnailUrl = img.Url,
            Mime = img.Mime,
            Width = img.Width,
            Height = img.Height,
            SizeBytes = img.SizeBytes,
            CreatedAt = img.CreatedAt,
            WorkspaceId = img.WorkspaceId,
        }).ToList();
    }

    private static string? Truncate(string? s, int max)
        => string.IsNullOrWhiteSpace(s) ? null
         : s.Length <= max ? s : s[..max] + "…";
}
