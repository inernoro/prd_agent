using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 视频生成领域服务实现（纯 OpenRouter 直出模式）
/// 2026-04-27 重构：原本支持 Remotion 拆分镜路径，现已简化为只调 OpenRouter 视频大模型。
/// </summary>
public class VideoGenService : IVideoGenService
{
    private readonly MongoDbContext _db;
    private readonly IRunEventStore _runStore;
    private readonly ILogger<VideoGenService> _logger;

    public VideoGenService(MongoDbContext db, IRunEventStore runStore, ILogger<VideoGenService> logger)
    {
        _db = db;
        _runStore = runStore;
        _logger = logger;
    }

    public async Task<string> CreateRunAsync(string appKey, string ownerAdminId, CreateVideoGenRunRequest request, CancellationToken ct = default)
    {
        var mode = (request?.Mode ?? VideoGenMode.Direct).Trim().ToLowerInvariant();
        if (mode is not (VideoGenMode.Direct or VideoGenMode.Storyboard)) mode = VideoGenMode.Direct;

        var duration = request?.DirectDuration ?? 5;
        if (duration < 1 || duration > 60) duration = 5;

        var aspect = (request?.DirectAspectRatio ?? "16:9").Trim();
        if (aspect is not ("16:9" or "9:16" or "1:1" or "4:3" or "3:4" or "21:9" or "9:21")) aspect = "16:9";

        var resolution = (request?.DirectResolution ?? "720p").Trim();
        if (resolution is not ("480p" or "720p" or "1080p" or "1K" or "2K" or "4K")) resolution = "720p";

        var model = (request?.DirectVideoModel ?? "alibaba/wan-2.6").Trim();

        if (mode == VideoGenMode.Storyboard)
        {
            // 高级创作：拆分镜路径
            var article = (request?.ArticleMarkdown ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(article))
                throw new ArgumentException("高级创作（storyboard）需要文章/PRD 文本");
            if (article.Length > 100_000)
                article = article[..100_000];

            var run = new VideoGenRun
            {
                AppKey = appKey,
                OwnerAdminId = ownerAdminId,
                Status = VideoGenRunStatus.Queued,
                Mode = VideoGenMode.Storyboard,
                ArticleMarkdown = article,
                StyleDescription = string.IsNullOrWhiteSpace(request?.StyleDescription) ? null : request!.StyleDescription!.Trim(),
                ArticleTitle = !string.IsNullOrWhiteSpace(request?.ArticleTitle)
                    ? request!.ArticleTitle!.Trim()
                    : (article.Length > 60 ? article[..60] + "…" : article),
                DirectVideoModel = model,
                DirectAspectRatio = aspect,
                DirectResolution = resolution,
                DirectDuration = duration,
                CurrentPhase = "queued",
                CreatedAt = DateTime.UtcNow,
            };
            await _db.VideoGenRuns.InsertOneAsync(run, cancellationToken: ct);
            _logger.LogInformation("VideoGen storyboard Run 已创建: runId={RunId}, articleLen={Len}",
                run.Id, article.Length);
            return run.Id;
        }

        // direct 模式：兼容字段——用户没填 directPrompt 但传了 articleMarkdown，自动当 prompt
        var prompt = (request?.DirectPrompt ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(prompt))
        {
            var fallback = (request?.ArticleMarkdown ?? string.Empty).Trim();
            if (!string.IsNullOrWhiteSpace(fallback))
            {
                prompt = fallback.Length <= 4000
                    ? fallback
                    : fallback[..3500] + "\n…\n" + fallback[^400..];
            }
        }

        if (string.IsNullOrWhiteSpace(prompt))
            throw new ArgumentException("视频生成需要 prompt：请输入视频描述或粘贴文本");
        if (prompt.Length > 4000)
            throw new ArgumentException("prompt 超过 4000 字限制");

        var directRun = new VideoGenRun
        {
            AppKey = appKey,
            OwnerAdminId = ownerAdminId,
            Status = VideoGenRunStatus.Queued,
            Mode = VideoGenMode.Direct,
            DirectPrompt = prompt,
            ArticleTitle = !string.IsNullOrWhiteSpace(request?.ArticleTitle)
                ? request!.ArticleTitle!.Trim()
                : (prompt.Length > 60 ? prompt[..60] + "…" : prompt),
            DirectVideoModel = model,
            DirectAspectRatio = aspect,
            DirectResolution = resolution,
            DirectDuration = duration,
            TotalDurationSeconds = duration,
            CurrentPhase = "queued",
            CreatedAt = DateTime.UtcNow,
        };

        await _db.VideoGenRuns.InsertOneAsync(directRun, cancellationToken: ct);
        _logger.LogInformation("VideoGen direct Run 已创建: runId={RunId}, model={Model}, duration={Duration}s",
            directRun.Id, model, duration);
        return directRun.Id;
    }

    public async Task UpdateSceneAsync(string runId, string ownerAdminId, int sceneIndex, UpdateVideoSceneRequest request, string? appKey = null, CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");
        if (run.Status != VideoGenRunStatus.Editing)
            throw new InvalidOperationException("仅在编辑阶段可修改分镜");
        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            throw new ArgumentOutOfRangeException(nameof(sceneIndex), "分镜序号超出范围");

        var update = Builders<VideoGenRun>.Update.Combine();
        var updates = new List<UpdateDefinition<VideoGenRun>>();
        if (!string.IsNullOrWhiteSpace(request.Topic)) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Topic", request.Topic.Trim()));
        if (!string.IsNullOrWhiteSpace(request.Prompt)) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Prompt", request.Prompt.Trim()));
        if (request.Model != null) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Model", string.IsNullOrWhiteSpace(request.Model) ? null : request.Model.Trim()));
        if (request.Duration.HasValue && request.Duration.Value > 0) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Duration", request.Duration));
        if (request.AspectRatio != null) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.AspectRatio", string.IsNullOrWhiteSpace(request.AspectRatio) ? null : request.AspectRatio.Trim()));
        if (request.Resolution != null) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Resolution", string.IsNullOrWhiteSpace(request.Resolution) ? null : request.Resolution.Trim()));
        if (updates.Count == 0) return;

        await _db.VideoGenRuns.UpdateOneAsync(x => x.Id == runId,
            Builders<VideoGenRun>.Update.Combine(updates), cancellationToken: ct);
    }

    public async Task RegenerateSceneAsync(string runId, string ownerAdminId, int sceneIndex, string? appKey = null, CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");
        if (run.Status != VideoGenRunStatus.Editing)
            throw new InvalidOperationException("仅在编辑阶段可重新生成分镜");
        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            throw new ArgumentOutOfRangeException(nameof(sceneIndex), "分镜序号超出范围");

        await _db.VideoGenRuns.UpdateOneAsync(x => x.Id == runId,
            Builders<VideoGenRun>.Update
                .Set($"Scenes.{sceneIndex}.Status", SceneItemStatus.Generating)
                .Set($"Scenes.{sceneIndex}.ErrorMessage", (string?)null),
            cancellationToken: ct);
    }

    public async Task RenderSceneAsync(string runId, string ownerAdminId, int sceneIndex, string? appKey = null, CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");
        if (run.Status != VideoGenRunStatus.Editing)
            throw new InvalidOperationException("仅在编辑阶段可生成分镜视频");
        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            throw new ArgumentOutOfRangeException(nameof(sceneIndex), "分镜序号超出范围");

        await _db.VideoGenRuns.UpdateOneAsync(x => x.Id == runId,
            Builders<VideoGenRun>.Update
                .Set($"Scenes.{sceneIndex}.Status", SceneItemStatus.Rendering)
                .Set($"Scenes.{sceneIndex}.ErrorMessage", (string?)null)
                .Set($"Scenes.{sceneIndex}.VideoUrl", (string?)null),
            cancellationToken: ct);
    }

    public async Task<VideoGenRun?> GetRunAsync(string runId, string ownerAdminId, string? appKey = null, CancellationToken ct = default)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.Eq(x => x.Id, runId) & fb.Eq(x => x.OwnerAdminId, ownerAdminId);
        if (appKey != null) filter &= fb.Eq(x => x.AppKey, appKey);
        return await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(ct);
    }

    public async Task<(long total, List<VideoGenRun> items)> ListRunsAsync(string ownerAdminId, string? appKey = null, int limit = 20, int skip = 0, CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 50);
        skip = Math.Max(skip, 0);

        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.Eq(x => x.OwnerAdminId, ownerAdminId);
        if (appKey != null) filter &= fb.Eq(x => x.AppKey, appKey);

        var sort = Builders<VideoGenRun>.Sort.Descending(x => x.CreatedAt);
        var total = await _db.VideoGenRuns.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.VideoGenRuns.Find(filter).Sort(sort).Skip(skip).Limit(limit).ToListAsync(ct);
        return (total, items);
    }

    public async Task<bool> CancelRunAsync(string runId, string ownerAdminId, string? appKey = null, CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct);
        if (run == null) return false;

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update.Set(x => x.CancelRequested, true),
            cancellationToken: ct);

        await PublishEventAsync(runId, "run.cancel.requested", new { });
        return true;
    }

    public async Task<long> CountTodayRunsAsync(string ownerAdminId, string appKey, CancellationToken ct = default)
    {
        var startOfDay = DateTime.UtcNow.Date;
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.Eq(x => x.OwnerAdminId, ownerAdminId)
                    & fb.Eq(x => x.AppKey, appKey)
                    & fb.Gte(x => x.CreatedAt, startOfDay);
        return await _db.VideoGenRuns.CountDocumentsAsync(filter, cancellationToken: ct);
    }

    public async Task<VideoGenRun?> WaitForCompletionAsync(string runId, TimeSpan timeout, CancellationToken ct = default)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var run = await _db.VideoGenRuns.Find(x => x.Id == runId).FirstOrDefaultAsync(ct);
            if (run == null) return null;
            if (run.Status == VideoGenRunStatus.Completed
                || run.Status == VideoGenRunStatus.Failed
                || run.Status == VideoGenRunStatus.Cancelled)
            {
                return run;
            }
            await Task.Delay(TimeSpan.FromSeconds(2), ct);
        }
        return null;
    }

    private async Task PublishEventAsync(string runId, string eventName, object payload)
    {
        try
        {
            await _runStore.AppendEventAsync(RunKinds.VideoGen, runId, eventName, payload,
                ttl: TimeSpan.FromHours(2), ct: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "VideoGen 事件发布失败: runId={RunId}, event={Event}", runId, eventName);
        }
    }
}
