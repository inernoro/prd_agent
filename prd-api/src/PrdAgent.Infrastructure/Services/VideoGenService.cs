using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 视频生成领域服务实现
/// 封装 video_gen_runs 集合的 CRUD 与状态流转逻辑，
/// 供多个 Controller 和工作流胶囊复用。
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
        var markdown = (request?.ArticleMarkdown ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(markdown))
            throw new ArgumentException("文章内容不能为空");

        if (markdown.Length > 100_000)
            throw new ArgumentException("文章内容超过 10 万字限制");

        var title = (request?.ArticleTitle ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(title)) title = null;

        var run = new VideoGenRun
        {
            AppKey = appKey,
            OwnerAdminId = ownerAdminId,
            Status = VideoGenRunStatus.Queued,
            ArticleMarkdown = markdown,
            ArticleTitle = title,
            SystemPrompt = request?.SystemPrompt?.Trim(),
            StyleDescription = request?.StyleDescription?.Trim(),
            CreatedAt = DateTime.UtcNow
        };

        await _db.VideoGenRuns.InsertOneAsync(run, cancellationToken: ct);

        _logger.LogInformation("VideoGen Run 已创建: runId={RunId}, appKey={AppKey}, titleLen={TitleLen}, mdLen={MdLen}",
            run.Id, appKey, title?.Length ?? 0, markdown.Length);

        return run.Id;
    }

    public async Task<VideoGenRun?> GetRunAsync(string runId, string ownerAdminId, string? appKey = null, CancellationToken ct = default)
    {
        runId = (runId ?? string.Empty).Trim();
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

    public async Task<(VideoGenScene scene, double totalDuration)> UpdateSceneAsync(string runId, string ownerAdminId, int sceneIndex, UpdateVideoSceneRequest request, string? appKey = null, CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");

        if (run.Status != VideoGenRunStatus.Editing)
            throw new InvalidOperationException("仅在编辑阶段可修改分镜");

        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            throw new ArgumentOutOfRangeException(nameof(sceneIndex), "分镜序号超出范围");

        var scene = run.Scenes[sceneIndex];
        if (!string.IsNullOrWhiteSpace(request.Topic)) scene.Topic = request.Topic.Trim();
        if (!string.IsNullOrWhiteSpace(request.Narration)) scene.Narration = request.Narration.Trim();
        if (!string.IsNullOrWhiteSpace(request.VisualDescription)) scene.VisualDescription = request.VisualDescription.Trim();
        if (!string.IsNullOrWhiteSpace(request.SceneType)) scene.SceneType = request.SceneType.Trim();

        scene.DurationSeconds = Math.Max(3, Math.Round(scene.Narration.Length / 3.7, 1));
        var totalDuration = run.Scenes.Sum(s => s.DurationSeconds);

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update
                .Set(x => x.Scenes, run.Scenes)
                .Set(x => x.TotalDurationSeconds, totalDuration),
            cancellationToken: ct);

        return (scene, totalDuration);
    }

    public async Task RegenerateSceneAsync(string runId, string ownerAdminId, int sceneIndex, string? appKey = null, CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");

        if (run.Status != VideoGenRunStatus.Editing)
            throw new InvalidOperationException("仅在编辑阶段可重新生成分镜");

        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            throw new ArgumentOutOfRangeException(nameof(sceneIndex), "分镜序号超出范围");

        run.Scenes[sceneIndex].Status = SceneItemStatus.Generating;
        run.Scenes[sceneIndex].ErrorMessage = null;

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update.Set(x => x.Scenes, run.Scenes),
            cancellationToken: ct);
    }

    public async Task TriggerRenderAsync(string runId, string ownerAdminId, string? appKey = null, CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");

        if (run.Status != VideoGenRunStatus.Editing)
            throw new InvalidOperationException("仅在编辑阶段可触发导出");

        if (run.Scenes.Count == 0)
            throw new InvalidOperationException("没有分镜数据");

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId && x.Status == VideoGenRunStatus.Editing,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Rendering)
                .Set(x => x.CurrentPhase, "rendering")
                .Set(x => x.PhaseProgress, 0),
            cancellationToken: ct);

        await PublishEventAsync(runId, "phase.changed", new { phase = "rendering", progress = 0 });

        _logger.LogInformation("VideoGen 触发渲染: runId={RunId}, scenes={Count}", runId, run.Scenes.Count);
    }

    public async Task RequestScenePreviewAsync(string runId, string ownerAdminId, int sceneIndex, string? appKey = null, CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");

        if (run.Status != VideoGenRunStatus.Editing)
            throw new InvalidOperationException("仅在编辑阶段可生成预览");

        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            throw new ArgumentOutOfRangeException(nameof(sceneIndex), "分镜序号超出范围");

        run.Scenes[sceneIndex].ImageStatus = "running";
        run.Scenes[sceneIndex].ImageUrl = null;

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update.Set(x => x.Scenes, run.Scenes),
            cancellationToken: ct);

        _logger.LogInformation("VideoGen 分镜预览排队: runId={RunId}, scene={Scene}", runId, sceneIndex);
    }

    public async Task RequestSceneBgImageAsync(string runId, string ownerAdminId, int sceneIndex, string? appKey = null, CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");

        if (run.Status != VideoGenRunStatus.Editing)
            throw new InvalidOperationException("仅在编辑阶段可生成背景图");

        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            throw new ArgumentOutOfRangeException(nameof(sceneIndex), "分镜序号超出范围");

        run.Scenes[sceneIndex].BackgroundImageStatus = "running";
        run.Scenes[sceneIndex].BackgroundImageUrl = null;

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update.Set(x => x.Scenes, run.Scenes),
            cancellationToken: ct);

        _logger.LogInformation("VideoGen 背景图排队: runId={RunId}, scene={Scene}", runId, sceneIndex);
    }

    public async Task<bool> CancelRunAsync(string runId, string ownerAdminId, string? appKey = null, CancellationToken ct = default)
    {
        runId = (runId ?? string.Empty).Trim();
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.Eq(x => x.Id, runId) & fb.Eq(x => x.OwnerAdminId, ownerAdminId);
        if (appKey != null) filter &= fb.Eq(x => x.AppKey, appKey);

        var res = await _db.VideoGenRuns.UpdateOneAsync(
            filter,
            Builders<VideoGenRun>.Update.Set(x => x.CancelRequested, true),
            cancellationToken: ct);

        return res.MatchedCount > 0;
    }

    public async Task<long> CountTodayRunsAsync(string ownerAdminId, string appKey, CancellationToken ct = default)
    {
        var todayStart = DateTime.UtcNow.Date;
        return await _db.VideoGenRuns.CountDocumentsAsync(
            x => x.OwnerAdminId == ownerAdminId
              && x.AppKey == appKey
              && x.CreatedAt >= todayStart,
            cancellationToken: ct);
    }

    public async Task<VideoGenRun?> WaitForCompletionAsync(string runId, TimeSpan timeout, CancellationToken ct = default)
    {
        var deadline = DateTime.UtcNow + timeout;

        while (DateTime.UtcNow < deadline && !ct.IsCancellationRequested)
        {
            var run = await _db.VideoGenRuns.Find(x => x.Id == runId).FirstOrDefaultAsync(ct);
            if (run == null) return null;

            if (run.Status is VideoGenRunStatus.Completed or VideoGenRunStatus.Failed or VideoGenRunStatus.Cancelled)
                return run;

            await Task.Delay(TimeSpan.FromSeconds(3), ct);
        }

        return await _db.VideoGenRuns.Find(x => x.Id == runId).FirstOrDefaultAsync(ct);
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
