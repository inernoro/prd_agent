using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Assets;

/// <summary>
/// 披露用户上传的附件（attachments 集合）。
/// 按 MIME 自动分类：image/* → image, pdf/text/word → document, 其余 → attachment。
/// </summary>
public class AttachmentAssetProvider : IAssetProvider
{
    private readonly MongoDbContext _db;
    public AttachmentAssetProvider(MongoDbContext db) => _db = db;

    public string Source => "手动上传";
    public string[] SupportedCategories => ["image", "document", "attachment"];

    public async Task<List<UnifiedAsset>> GetAssetsAsync(string userId, int limit, CancellationToken ct)
    {
        var attachments = await _db.Attachments
            .Find(a => a.UploaderId == userId)
            .SortByDescending(a => a.UploadedAt)
            .Limit(limit)
            .ToListAsync(ct);

        return attachments.Select(att =>
        {
            var mime = att.MimeType ?? "";
            var assetType = ClassifyMime(mime);

            return new UnifiedAsset
            {
                Id = $"att-{att.AttachmentId}",
                Type = assetType,
                Title = att.FileName,
                Summary = FormatSummary(mime, att.Size),
                Source = Source,
                Url = att.Url,
                ThumbnailUrl = att.ThumbnailUrl ?? (assetType == "image" ? att.Url : null),
                Mime = att.MimeType,
                Width = 0,
                Height = 0,
                SizeBytes = att.Size,
                CreatedAt = att.UploadedAt,
            };
        }).ToList();
    }

    private static string ClassifyMime(string mime)
    {
        if (mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            return "image";
        if (mime.Contains("pdf") || mime.Contains("text")
         || mime.Contains("document") || mime.Contains("word"))
            return "document";
        return "attachment";
    }

    private static string FormatSummary(string mime, long sizeBytes)
    {
        var ext = mime.Split('/').LastOrDefault()?.ToUpperInvariant() ?? "FILE";
        var size = sizeBytes switch
        {
            < 1024 => $"{sizeBytes} B",
            < 1024 * 1024 => $"{sizeBytes / 1024.0:F1} KB",
            _ => $"{sizeBytes / (1024.0 * 1024.0):F1} MB",
        };
        return $"{ext} · {size}";
    }
}
