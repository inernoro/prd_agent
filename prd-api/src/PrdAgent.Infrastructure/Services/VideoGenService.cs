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
        // 兼容字段：用户没填 directPrompt 但传了 articleMarkdown，自动当 prompt 用
        var prompt = (request?.DirectPrompt ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(prompt))
        {
            var fallback = (request?.ArticleMarkdown ?? string.Empty).Trim();
            if (!string.IsNullOrWhiteSpace(fallback))
            {
                // OpenRouter 直出 prompt 限 4000 字，超出截断保留首尾
                prompt = fallback.Length <= 4000
                    ? fallback
                    : fallback[..3500] + "\n…\n" + fallback[^400..];
                _logger.LogInformation("VideoGen 自动从 articleMarkdown 生成 prompt: appKey={AppKey}, len={Len}",
                    appKey, prompt.Length);
            }
        }

        if (string.IsNullOrWhiteSpace(prompt))
            throw new ArgumentException("视频生成需要 prompt：请输入视频描述或粘贴文本");
        if (prompt.Length > 4000)
            throw new ArgumentException("prompt 超过 4000 字限制");

        var duration = request?.DirectDuration ?? 5;
        if (duration < 1 || duration > 60) duration = 5;

        var aspect = (request?.DirectAspectRatio ?? "16:9").Trim();
        if (aspect is not ("16:9" or "9:16" or "1:1" or "4:3" or "3:4" or "21:9" or "9:21")) aspect = "16:9";

        var resolution = (request?.DirectResolution ?? "720p").Trim();
        if (resolution is not ("480p" or "720p" or "1080p" or "1K" or "2K" or "4K")) resolution = "720p";

        var model = (request?.DirectVideoModel ?? "alibaba/wan-2.6").Trim();

        var run = new VideoGenRun
        {
            AppKey = appKey,
            OwnerAdminId = ownerAdminId,
            Status = VideoGenRunStatus.Queued,
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

        await _db.VideoGenRuns.InsertOneAsync(run, cancellationToken: ct);
        _logger.LogInformation("VideoGen Run 已创建: runId={RunId}, model={Model}, duration={Duration}s, aspect={Aspect}",
            run.Id, model, duration, aspect);
        return run.Id;
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
