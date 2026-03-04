using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Assets;

/// <summary>
/// 披露已完成的视频生成任务（video_gen_runs 集合）
/// </summary>
public class VideoAssetProvider : IAssetProvider
{
    private readonly MongoDbContext _db;
    public VideoAssetProvider(MongoDbContext db) => _db = db;

    public string Source => "视频 Agent";
    public string[] SupportedCategories => ["attachment"];

    public async Task<List<UnifiedAsset>> GetAssetsAsync(string userId, int limit, CancellationToken ct)
    {
        // 只展示已完成且有产出的视频
        var filter = Builders<VideoGenRun>.Filter.Eq(r => r.OwnerAdminId, userId)
                   & Builders<VideoGenRun>.Filter.Eq(r => r.Status, VideoGenRunStatus.Completed)
                   & Builders<VideoGenRun>.Filter.Ne(r => r.VideoAssetUrl, null);

        var runs = await _db.VideoGenRuns
            .Find(filter)
            .SortByDescending(r => r.CreatedAt)
            .Limit(limit)
            .ToListAsync(ct);

        return runs.Select(r => new UnifiedAsset
        {
            Id = $"vid-{r.Id}",
            Type = "attachment",
            Title = r.ArticleTitle ?? "视频教程",
            Summary = FormatSummary(r),
            Source = Source,
            Url = r.VideoAssetUrl,
            Mime = "video/mp4",
            CreatedAt = r.CreatedAt,
        }).ToList();
    }

    private static string FormatSummary(VideoGenRun r)
    {
        var scenes = r.Scenes?.Count ?? 0;
        var duration = r.TotalDurationSeconds > 0
            ? TimeSpan.FromSeconds(r.TotalDurationSeconds).ToString(@"mm\:ss")
            : null;
        return duration != null
            ? $"视频 · {scenes} 分镜 · {duration}"
            : $"视频 · {scenes} 分镜";
    }
}
