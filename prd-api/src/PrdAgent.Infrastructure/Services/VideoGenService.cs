using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 视频项目与生成任务领域服务实现。项目保存长期编辑状态，Run 表示一次生成，导出任务独立排队。
/// </summary>
public class VideoGenService : IVideoGenService
{
    private readonly MongoDbContext _db;
    private readonly IRunEventStore _runStore;
    private readonly IAssetStorage _assetStorage;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<VideoGenService> _logger;

    public VideoGenService(
        MongoDbContext db,
        IRunEventStore runStore,
        IAssetStorage assetStorage,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<VideoGenService> logger)
    {
        _db = db;
        _runStore = runStore;
        _assetStorage = assetStorage;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    public async Task<VideoProject> CreateProjectAsync(
        string appKey,
        string ownerAdminId,
        CreateVideoProjectRequest request,
        CancellationToken ct = default)
    {
        var source = (request?.SourceMarkdown ?? string.Empty).Trim();
        if (source.Length > 100_000) source = source[..100_000];
        var project = new VideoProject
        {
            AppKey = appKey,
            OwnerAdminId = ownerAdminId,
            Title = NormalizeTitle(request?.Title, source),
            SourceMarkdown = source,
            StyleDescription = NormalizeOptional(request?.StyleDescription),
            DefaultVideoModel = NormalizeOptional(request?.DefaultVideoModel),
            DefaultAspectRatio = NormalizeAspectRatio(request?.DefaultAspectRatio),
            DefaultResolution = NormalizeResolution(request?.DefaultResolution, "1080p"),
            DefaultDuration = NormalizeDuration(request?.DefaultDuration),
            GenerateAudio = request?.GenerateAudio ?? true,
            Assets = NormalizeAssets(request?.Assets),
            TimelineTracks = NormalizeTimelineTracks(request?.TimelineTracks),
        };
        await _db.VideoProjects.InsertOneAsync(project, cancellationToken: ct);
        return project;
    }

    public async Task<VideoProject?> GetProjectAsync(
        string projectId,
        string ownerAdminId,
        string? appKey = null,
        CancellationToken ct = default)
    {
        var fb = Builders<VideoProject>.Filter;
        var filter = fb.Eq(x => x.Id, projectId) & fb.Eq(x => x.OwnerAdminId, ownerAdminId);
        if (appKey != null) filter &= fb.Eq(x => x.AppKey, appKey);
        return await _db.VideoProjects.Find(filter).FirstOrDefaultAsync(ct);
    }

    public async Task<List<VideoProject>> ListProjectsAsync(
        string ownerAdminId,
        string? appKey = null,
        CancellationToken ct = default)
    {
        var fb = Builders<VideoProject>.Filter;
        var filter = fb.Eq(x => x.OwnerAdminId, ownerAdminId);
        if (appKey != null) filter &= fb.Eq(x => x.AppKey, appKey);
        return await _db.VideoProjects.Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(100)
            .ToListAsync(ct);
    }

    public async Task<VideoProject> UpdateProjectAsync(
        string projectId,
        string ownerAdminId,
        UpdateVideoProjectRequest request,
        string? appKey = null,
        CancellationToken ct = default)
    {
        var project = await GetProjectAsync(projectId, ownerAdminId, appKey, ct)
                      ?? throw new KeyNotFoundException("视频项目不存在");
        var updates = new List<UpdateDefinition<VideoProject>>
        {
            Builders<VideoProject>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow),
        };
        if (request.Title != null) updates.Add(Builders<VideoProject>.Update.Set(x => x.Title, NormalizeTitle(request.Title, project.SourceMarkdown)));
        if (request.SourceMarkdown != null)
        {
            var source = request.SourceMarkdown.Trim();
            updates.Add(Builders<VideoProject>.Update.Set(x => x.SourceMarkdown, source[..Math.Min(source.Length, 100_000)]));
        }
        if (request.StyleDescription != null) updates.Add(Builders<VideoProject>.Update.Set(x => x.StyleDescription, NormalizeOptional(request.StyleDescription)));
        if (request.DefaultVideoModel != null) updates.Add(Builders<VideoProject>.Update.Set(x => x.DefaultVideoModel, NormalizeOptional(request.DefaultVideoModel)));
        if (request.DefaultAspectRatio != null) updates.Add(Builders<VideoProject>.Update.Set(x => x.DefaultAspectRatio, NormalizeAspectRatio(request.DefaultAspectRatio)));
        if (request.DefaultResolution != null) updates.Add(Builders<VideoProject>.Update.Set(x => x.DefaultResolution, NormalizeResolution(request.DefaultResolution, project.DefaultResolution)));
        if (request.DefaultDuration.HasValue) updates.Add(Builders<VideoProject>.Update.Set(x => x.DefaultDuration, NormalizeDuration(request.DefaultDuration)));
        if (request.GenerateAudio.HasValue) updates.Add(Builders<VideoProject>.Update.Set(x => x.GenerateAudio, request.GenerateAudio.Value));
        if (request.Assets != null) updates.Add(Builders<VideoProject>.Update.Set(x => x.Assets, NormalizeAssets(request.Assets)));
        if (request.TimelineTracks != null) updates.Add(Builders<VideoProject>.Update.Set(x => x.TimelineTracks, NormalizeTimelineTracks(request.TimelineTracks)));

        await _db.VideoProjects.UpdateOneAsync(x => x.Id == projectId && x.OwnerAdminId == ownerAdminId,
            Builders<VideoProject>.Update.Combine(updates), cancellationToken: ct);
        return await GetProjectAsync(projectId, ownerAdminId, appKey, ct)
               ?? throw new KeyNotFoundException("视频项目不存在");
    }

    public async Task<string> CreateRunAsync(string appKey, string ownerAdminId, CreateVideoGenRunRequest request, CancellationToken ct = default)
    {
        VideoProject? project = null;
        if (!string.IsNullOrWhiteSpace(request?.ProjectId))
        {
            project = await GetProjectAsync(request.ProjectId.Trim(), ownerAdminId, appKey, ct)
                      ?? throw new ArgumentException("所属视频项目不存在或无权访问");
        }
        var mode = (request?.Mode ?? VideoGenMode.Direct).Trim().ToLowerInvariant();
        if (mode is not (VideoGenMode.Direct or VideoGenMode.Storyboard)) mode = VideoGenMode.Direct;

        var duration = request?.DirectDuration ?? project?.DefaultDuration ?? 5;
        if (duration < 1 || duration > 60) duration = 5;

        var aspect = (request?.DirectAspectRatio ?? project?.DefaultAspectRatio ?? "16:9").Trim();
        if (aspect is not ("16:9" or "9:16" or "1:1" or "4:3" or "3:4" or "21:9" or "9:21")) aspect = "16:9";

        var resolution = (request?.DirectResolution ?? project?.DefaultResolution ?? "720p").Trim();
        if (resolution is not ("480p" or "720p" or "1080p" or "1K" or "2K" or "4K")) resolution = "720p";

        // 不再硬编码 alibaba/wan-2.6 默认：未指定时留空，由 AppCaller 对应的视频池(visual-agent / video-agent)
        // 解析各自的默认模型。否则会以 Wan 当 expectedModel 搜遍所有 VideoGen 池命中含 Wan 的池，
        // 绕过 visual-agent 池配置（即便用的是 visual app caller）（Codex review）。
        var modelRaw = (request?.DirectVideoModel ?? project?.DefaultVideoModel ?? string.Empty).Trim();
        var model = string.IsNullOrWhiteSpace(modelRaw) ? null : modelRaw;

        if (mode == VideoGenMode.Storyboard)
        {
            // 高级创作：拆分镜路径
            var article = (request?.ArticleMarkdown ?? project?.SourceMarkdown ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(article))
                throw new ArgumentException("高级创作（storyboard）需要文章/PRD 文本");
            if (article.Length > 100_000)
                article = article[..100_000];

            var run = new VideoGenRun
            {
                AppKey = appKey,
                ProjectId = project?.Id,
                OwnerAdminId = ownerAdminId,
                Status = VideoGenRunStatus.Queued,
                Mode = VideoGenMode.Storyboard,
                ArticleMarkdown = article,
                StyleDescription = string.IsNullOrWhiteSpace(request?.StyleDescription)
                    ? project?.StyleDescription
                    : request!.StyleDescription!.Trim(),
                ArticleTitle = !string.IsNullOrWhiteSpace(request?.ArticleTitle)
                    ? request!.ArticleTitle!.Trim()
                    : project?.Title ?? (article.Length > 60 ? article[..60] + "…" : article),
                DirectVideoModel = model,
                DirectAspectRatio = aspect,
                DirectResolution = resolution,
                DirectDuration = duration,
                GenerateAudio = request?.GenerateAudio ?? project?.GenerateAudio ?? true,
                CurrentPhase = "queued",
                ForceFullShadowSample = _llmRequestContext.Current?.ForceFullShadowSample == true,
                CreatedAt = DateTime.UtcNow,
            };
            await _db.VideoGenRuns.InsertOneAsync(run, cancellationToken: ct);
            if (project != null)
            {
                await _db.VideoProjects.UpdateOneAsync(x => x.Id == project.Id,
                    Builders<VideoProject>.Update
                        .Set(x => x.LatestRunId, run.Id)
                        .Set(x => x.Status, VideoProjectStatus.Analyzing)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);
            }
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
            ProjectId = project?.Id,
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
            GenerateAudio = request?.GenerateAudio ?? project?.GenerateAudio ?? true,
            DirectFirstFrameUrl = string.IsNullOrWhiteSpace(request?.DirectFirstFrameUrl) ? null : request!.DirectFirstFrameUrl!.Trim(),
            TotalDurationSeconds = duration,
            CurrentPhase = "queued",
            ForceFullShadowSample = _llmRequestContext.Current?.ForceFullShadowSample == true,
            CreatedAt = DateTime.UtcNow,
        };

        await _db.VideoGenRuns.InsertOneAsync(directRun, cancellationToken: ct);
        if (project != null)
        {
            await _db.VideoProjects.UpdateOneAsync(x => x.Id == project.Id,
                Builders<VideoProject>.Update
                    .Set(x => x.LatestRunId, directRun.Id)
                    .Set(x => x.Status, VideoProjectStatus.Rendering)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);
        }
        _logger.LogInformation("VideoGen direct Run 已创建: runId={RunId}, model={Model}, duration={Duration}s",
            directRun.Id, model, duration);
        return directRun.Id;
    }

    public async Task UpdateSceneAsync(string runId, string ownerAdminId, int sceneIndex, UpdateVideoSceneRequest request, string? appKey = null, CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");
        if (run.Status is not (VideoGenRunStatus.Editing or VideoGenRunStatus.Completed))
            throw new InvalidOperationException("仅在编辑阶段可修改分镜");
        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            throw new ArgumentOutOfRangeException(nameof(sceneIndex), "分镜序号超出范围");

        var updates = new List<UpdateDefinition<VideoGenRun>>();
        if (!string.IsNullOrWhiteSpace(request.Topic)) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Topic", request.Topic.Trim()));
        if (!string.IsNullOrWhiteSpace(request.Prompt)) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Prompt", request.Prompt.Trim()));
        if (request.Model != null) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Model", string.IsNullOrWhiteSpace(request.Model) ? null : request.Model.Trim()));
        if (request.Duration.HasValue && request.Duration.Value > 0) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Duration", request.Duration));
        if (request.AspectRatio != null) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.AspectRatio", string.IsNullOrWhiteSpace(request.AspectRatio) ? null : request.AspectRatio.Trim()));
        if (request.Resolution != null) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Resolution", string.IsNullOrWhiteSpace(request.Resolution) ? null : request.Resolution.Trim()));
        if (request.FirstFrameUrl != null) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.FirstFrameUrl", LimitOptional(request.FirstFrameUrl, 2_000)));
        if (request.LastFrameUrl != null) updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.LastFrameUrl", LimitOptional(request.LastFrameUrl, 2_000)));
        if (updates.Count == 0) return;
        if (run.Status == VideoGenRunStatus.Completed) AddReopenEditingUpdates(updates);

        await _db.VideoGenRuns.UpdateOneAsync(x => x.Id == runId,
            Builders<VideoGenRun>.Update.Combine(updates), cancellationToken: ct);
    }

    public async Task RegenerateSceneAsync(string runId, string ownerAdminId, int sceneIndex, string? appKey = null, CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");
        if (run.Status is not (VideoGenRunStatus.Editing or VideoGenRunStatus.Completed))
            throw new InvalidOperationException("仅在编辑阶段可重新生成分镜");
        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            throw new ArgumentOutOfRangeException(nameof(sceneIndex), "分镜序号超出范围");

        var updates = new List<UpdateDefinition<VideoGenRun>>
        {
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Status", SceneItemStatus.Generating),
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.ErrorMessage", (string?)null),
        };
        if (run.Status == VideoGenRunStatus.Completed) AddReopenEditingUpdates(updates);
        await _db.VideoGenRuns.UpdateOneAsync(x => x.Id == runId,
            Builders<VideoGenRun>.Update.Combine(updates),
            cancellationToken: ct);
    }

    public async Task RenderSceneAsync(string runId, string ownerAdminId, int sceneIndex, string? appKey = null, CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");
        if (run.Status is not (VideoGenRunStatus.Editing or VideoGenRunStatus.Completed))
            throw new InvalidOperationException("仅在编辑阶段可生成分镜视频");
        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            throw new ArgumentOutOfRangeException(nameof(sceneIndex), "分镜序号超出范围");
        if (run.Scenes[sceneIndex].Status is SceneItemStatus.Submitting or SceneItemStatus.SubmittingClaimed or SceneItemStatus.Polling or SceneItemStatus.PollingClaimed or SceneItemStatus.Rendering)
            return;
        if (run.Scenes[sceneIndex].Status == SceneItemStatus.Generating)
            throw new InvalidOperationException("分镜提示词正在改写，请完成后再生成视频");

        await TryQueueSceneRenderAsync(
            runId,
            ownerAdminId,
            sceneIndex,
            appKey,
            reopenCompletedRun: run.Status == VideoGenRunStatus.Completed,
            ct);
    }

    internal async Task<bool> TryQueueSceneRenderAsync(
        string runId,
        string ownerAdminId,
        int sceneIndex,
        string? appKey,
        bool reopenCompletedRun,
        CancellationToken ct = default)
    {
        var updates = new List<UpdateDefinition<VideoGenRun>>
        {
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Status", SceneItemStatus.Submitting),
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.ErrorMessage", (string?)null),
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.JobId", (string?)null),
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.SubmissionStartedAt", DateTime.UtcNow),
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.RenderLeaseId", (string?)null),
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.RenderLeaseExpiresAt", (DateTime?)null),
        };
        if (reopenCompletedRun) AddReopenEditingUpdates(updates);
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.Eq(x => x.Id, runId)
                     & fb.Eq(x => x.OwnerAdminId, ownerAdminId)
                     & fb.In(x => x.Status, [VideoGenRunStatus.Editing, VideoGenRunStatus.Completed])
                     & fb.Nin<string>($"Scenes.{sceneIndex}.Status",
                         [SceneItemStatus.Generating, SceneItemStatus.Submitting, SceneItemStatus.SubmittingClaimed, SceneItemStatus.Polling, SceneItemStatus.PollingClaimed, SceneItemStatus.Rendering]);
        if (appKey != null) filter &= fb.Eq(x => x.AppKey, appKey);
        var result = await _db.VideoGenRuns.UpdateOneAsync(
            filter,
            Builders<VideoGenRun>.Update.Combine(updates),
            cancellationToken: ct);
        return result.ModifiedCount == 1;
    }

    public async Task<int> RenderScenesAsync(
        string runId,
        string ownerAdminId,
        IReadOnlyCollection<int>? sceneIndexes = null,
        string? appKey = null,
        CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");
        if (run.Status is not (VideoGenRunStatus.Editing or VideoGenRunStatus.Completed))
            throw new InvalidOperationException("仅在编辑阶段可批量生成分镜视频");

        var requested = sceneIndexes == null || sceneIndexes.Count == 0
            ? null
            : sceneIndexes.ToHashSet();
        if (requested?.Any(index => index < 0 || index >= run.Scenes.Count) == true)
            throw new ArgumentOutOfRangeException(nameof(sceneIndexes), "分镜序号超出范围");

        var indexesToQueue = new List<int>();
        for (var index = 0; index < run.Scenes.Count; index++)
        {
            var scene = run.Scenes[index];
            if (requested != null && !requested.Contains(index)) continue;
            if (scene.Status is SceneItemStatus.Done or SceneItemStatus.Submitting or SceneItemStatus.SubmittingClaimed or SceneItemStatus.Polling or SceneItemStatus.PollingClaimed or SceneItemStatus.Rendering or SceneItemStatus.Generating) continue;
            indexesToQueue.Add(index);
        }

        if (indexesToQueue.Count == 0) return 0;
        var results = await Task.WhenAll(indexesToQueue.Select(index => TryQueueSceneRenderAsync(
            runId,
            ownerAdminId,
            index,
            appKey,
            reopenCompletedRun: run.Status == VideoGenRunStatus.Completed,
            ct)));
        var count = results.Count(queued => queued);
        if (count == 0) return 0;
        await PublishEventAsync(runId, "scenes.render.queued", new { count });
        return count;
    }

    public async Task ReorderScenesAsync(
        string runId,
        string ownerAdminId,
        IReadOnlyList<int> sceneIndexes,
        string? appKey = null,
        CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");
        if (run.Status is not (VideoGenRunStatus.Editing or VideoGenRunStatus.Completed))
            throw new InvalidOperationException("仅在编辑阶段可调整镜头顺序");
        var expected = Enumerable.Range(0, run.Scenes.Count).ToHashSet();
        if (sceneIndexes.Count != run.Scenes.Count || !expected.SetEquals(sceneIndexes))
            throw new ArgumentException("镜头顺序必须包含每个镜头且不能重复");

        var reordered = sceneIndexes.Select(index => run.Scenes[index]).ToList();
        for (var index = 0; index < reordered.Count; index++) reordered[index].Index = index;
        var runUpdates = new List<UpdateDefinition<VideoGenRun>>
        {
            Builders<VideoGenRun>.Update.Set(x => x.Scenes, reordered),
        };
        if (run.Status == VideoGenRunStatus.Completed) AddReopenEditingUpdates(runUpdates);
        await _db.VideoGenRuns.UpdateOneAsync(x => x.Id == run.Id,
            Builders<VideoGenRun>.Update.Combine(runUpdates), cancellationToken: ct);

        if (!string.IsNullOrWhiteSpace(run.ProjectId))
        {
            var project = await _db.VideoProjects.Find(x => x.Id == run.ProjectId).FirstOrDefaultAsync(ct);
            if (project != null)
            {
                var videoTrack = project.TimelineTracks.FirstOrDefault(track => track.Type == VideoTrackType.Video);
                if (videoTrack != null)
                {
                    double cursor = 0;
                    videoTrack.Clips = reordered.Select((scene, index) =>
                    {
                        var duration = scene.Duration ?? run.DirectDuration ?? 5;
                        var clip = new VideoTimelineClip
                        {
                            SceneIndex = index,
                            StartSeconds = cursor,
                            DurationSeconds = duration,
                            AssetUrl = scene.VideoUrl,
                        };
                        cursor += duration;
                        return clip;
                    }).ToList();
                    await _db.VideoProjects.UpdateOneAsync(x => x.Id == project.Id,
                        Builders<VideoProject>.Update
                            .Set(x => x.TimelineTracks, project.TimelineTracks)
                            .Set(x => x.Status, VideoProjectStatus.Editing)
                            .Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);
                }
            }
        }
        await PublishEventAsync(runId, "scenes.reordered", new { sceneIndexes });
    }

    public async Task ActivateSceneVersionAsync(
        string runId,
        string ownerAdminId,
        int sceneIndex,
        string versionId,
        string? appKey = null,
        CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");
        if (run.Status is not (VideoGenRunStatus.Editing or VideoGenRunStatus.Completed))
            throw new InvalidOperationException("仅在编辑阶段可切换分镜版本");
        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            throw new ArgumentOutOfRangeException(nameof(sceneIndex), "分镜序号超出范围");

        var version = run.Scenes[sceneIndex].Versions.FirstOrDefault(item => item.Id == versionId)
                      ?? throw new KeyNotFoundException("分镜版本不存在");
        var updates = new List<UpdateDefinition<VideoGenRun>>
        {
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.ActiveVersionId", version.Id),
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.VideoUrl", version.VideoUrl),
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.JobId", version.JobId),
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Model", version.Model),
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Duration", version.Duration),
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Cost", version.Cost),
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Status", SceneItemStatus.Done),
        };
        if (run.Status == VideoGenRunStatus.Completed) AddReopenEditingUpdates(updates);
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update.Combine(updates),
            cancellationToken: ct);
        await PublishEventAsync(runId, "scene.version.activated", new { sceneIndex, versionId });
    }

    public async Task<VideoExportTask> RequestExportAsync(
        string runId,
        string ownerAdminId,
        string? appKey = null,
        CancellationToken ct = default)
    {
        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");
        if (run.Mode != VideoGenMode.Storyboard)
            throw new InvalidOperationException("仅分镜项目需要合成导出");
        if (run.Status != VideoGenRunStatus.Editing)
            throw new InvalidOperationException("当前任务不在可导出状态");
        if (run.Scenes.Count == 0 || run.Scenes.Any(scene => scene.Status != SceneItemStatus.Done || string.IsNullOrWhiteSpace(scene.VideoUrl)))
            throw new InvalidOperationException("所有分镜生成完成后才能导出完整视频");

        var existing = await _db.VideoExportTasks.Find(task =>
                task.RunId == runId && task.OwnerAdminId == ownerAdminId &&
                (task.Status == VideoExportTaskStatus.Queued || task.Status == VideoExportTaskStatus.Processing))
            .FirstOrDefaultAsync(ct);
        if (existing != null) return existing;

        var task = new VideoExportTask
        {
            AppKey = run.AppKey,
            OwnerAdminId = ownerAdminId,
            ProjectId = run.ProjectId ?? string.Empty,
            RunId = run.Id,
            Progress = 1,
        };
        await _db.VideoExportTasks.InsertOneAsync(task, cancellationToken: ct);

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Rendering)
                .Set(x => x.ExportRequested, false)
                .Set(x => x.LatestExportTaskId, task.Id)
                .Set(x => x.ExportErrorMessage, (string?)null)
                .Set(x => x.CurrentPhase, "export-queued")
                .Set(x => x.PhaseProgress, 1),
            cancellationToken: ct);
        if (!string.IsNullOrWhiteSpace(run.ProjectId))
        {
            await _db.VideoProjects.UpdateOneAsync(
                x => x.Id == run.ProjectId && x.OwnerAdminId == ownerAdminId,
                Builders<VideoProject>.Update
                    .Set(x => x.LatestExportTaskId, task.Id)
                    .Set(x => x.Status, VideoProjectStatus.Rendering)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
        }
        await PublishEventAsync(runId, "export.queued", new { taskId = task.Id, sceneCount = run.Scenes.Count });
        return task;
    }

    public async Task<List<VideoExportTask>> ListExportTasksAsync(
        string projectId,
        string ownerAdminId,
        string? appKey = null,
        CancellationToken ct = default)
    {
        var fb = Builders<VideoExportTask>.Filter;
        var filter = fb.Eq(x => x.ProjectId, projectId) & fb.Eq(x => x.OwnerAdminId, ownerAdminId);
        if (appKey != null) filter &= fb.Eq(x => x.AppKey, appKey);
        return await _db.VideoExportTasks.Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Limit(50)
            .ToListAsync(ct);
    }

    public async Task<VideoGenRun?> GetRunAsync(string runId, string ownerAdminId, string? appKey = null, CancellationToken ct = default)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.Eq(x => x.Id, runId)
                     & fb.Eq(x => x.OwnerAdminId, ownerAdminId)
                     & fb.Eq(x => x.DeletionRequestedAt, null);
        if (appKey != null) filter &= fb.Eq(x => x.AppKey, appKey);
        return await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(ct);
    }

    public async Task<(long total, List<VideoGenRun> items)> ListRunsAsync(string ownerAdminId, string? appKey = null, int limit = 20, int skip = 0, CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 50);
        skip = Math.Max(skip, 0);

        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.Eq(x => x.OwnerAdminId, ownerAdminId)
                     & fb.Eq(x => x.DeletionRequestedAt, null);
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

    public async Task<DeleteVideoGenRunResult?> DeleteRunAsync(
        string runId,
        string ownerAdminId,
        bool deleteEmptyProject = false,
        string? appKey = null,
        CancellationToken ct = default)
    {
        await using var runDeletionLease = await VideoAssetMutationLease.AcquireAsync(
            _db,
            $"run-delete:{runId}",
            ct);
        var fb = Builders<VideoGenRun>.Filter;
        var ownedFilter = fb.Eq(x => x.Id, runId) & fb.Eq(x => x.OwnerAdminId, ownerAdminId);
        if (appKey != null) ownedFilter &= fb.Eq(x => x.AppKey, appKey);

        var run = await _db.VideoGenRuns.Find(ownedFilter).FirstOrDefaultAsync(ct);
        if (run == null) return null;
        if (run.Status is not (VideoGenRunStatus.Completed or VideoGenRunStatus.Failed or VideoGenRunStatus.Cancelled))
            throw new InvalidOperationException("任务仍在生成，请先取消并等待任务结束后再删除");

        if (run.DeletionRequestedAt == null)
        {
            var snapshot = CollectGeneratedVideoArtifacts(run)
                .Select(artifact => new VideoGenDeletionArtifact
                {
                    Sha256 = artifact.Sha256,
                    Urls = artifact.Urls.ToList(),
                })
                .ToList();
            run = await _db.VideoGenRuns.FindOneAndUpdateAsync(
                ownedFilter & fb.Eq(x => x.DeletionRequestedAt, null),
                Builders<VideoGenRun>.Update
                    .Set(x => x.DeletionRequestedAt, DateTime.UtcNow)
                    .Set(x => x.DeletionArtifacts, snapshot),
                new FindOneAndUpdateOptions<VideoGenRun>
                {
                    ReturnDocument = ReturnDocument.After,
                },
                ct) ?? await _db.VideoGenRuns.Find(ownedFilter).FirstOrDefaultAsync(ct);
            if (run == null) return null;
        }

        // 删除意图已经持久化；此后不再受请求断开影响，崩溃时由 VideoGenRunWorker 继续清理。
        var cleanupToken = CancellationToken.None;
        var artifacts = run.DeletionArtifacts
            .Select(artifact => new GeneratedVideoArtifact(artifact.Sha256, artifact.Urls))
            .ToList();
        var deletedArtifacts = 0;

        // 先清理依赖记录；任一步失败时，持久化删除标记仍保留，底层视频对象尚未被触碰。
        await _db.VideoExportTasks.DeleteManyAsync(
            task => task.RunId == run.Id
                    && task.OwnerAdminId == ownerAdminId
                    && task.AppKey == run.AppKey,
            cleanupToken);

        foreach (var artifact in artifacts)
        {
            await using var assetLease = await VideoAssetMutationLease.AcquireAsync(
                _db,
                $"generated-video:{artifact.Sha256}",
                cleanupToken);
            var referenceFilters = new List<FilterDefinition<VideoGenRun>>
            {
                fb.Eq(x => x.VideoAssetSha256, artifact.Sha256),
                fb.Eq("Scenes.Versions.AssetSha256", artifact.Sha256),
            };
            foreach (var url in artifact.Urls)
            {
                referenceFilters.Add(fb.Eq(x => x.VideoAssetUrl, url));
                referenceFilters.Add(fb.Eq("Scenes.Versions.VideoUrl", url));
            }
            var sharedReferenceCount = await _db.VideoGenRuns.CountDocumentsAsync(
                fb.Ne(x => x.Id, run.Id) & fb.Or(referenceFilters),
                cancellationToken: cleanupToken);
            if (sharedReferenceCount > 0) continue;
            await _assetStorage.DeleteByShaAsync(
                artifact.Sha256,
                cleanupToken,
                domain: AppDomainPaths.DomainVideoAgent,
                type: AppDomainPaths.TypeVideo);
            deletedArtifacts++;
        }

        var deleted = await _db.VideoGenRuns.DeleteOneAsync(
            ownedFilter & fb.Ne(x => x.DeletionRequestedAt, null),
            cleanupToken);
        if (deleted.DeletedCount != 1) return null;

        var projectDeleted = false;
        if (!string.IsNullOrWhiteSpace(run.ProjectId))
        {
            var project = await GetProjectAsync(run.ProjectId, ownerAdminId, appKey, cleanupToken);
            var remainingRuns = await _db.VideoGenRuns.CountDocumentsAsync(
                item => item.ProjectId == run.ProjectId
                        && item.OwnerAdminId == ownerAdminId
                        && item.AppKey == run.AppKey,
                cancellationToken: cleanupToken);
            var remainingExports = await _db.VideoExportTasks.CountDocumentsAsync(
                task => task.ProjectId == run.ProjectId
                        && task.OwnerAdminId == ownerAdminId
                        && task.AppKey == run.AppKey,
                cancellationToken: cleanupToken);
            if (deleteEmptyProject
                && project != null
                && project.Assets.Count == 0
                && remainingRuns == 0
                && remainingExports == 0)
            {
                var projectResult = await _db.VideoProjects.DeleteOneAsync(
                    item => item.Id == run.ProjectId
                            && item.OwnerAdminId == ownerAdminId
                            && item.AppKey == run.AppKey,
                    cleanupToken);
                projectDeleted = projectResult.DeletedCount == 1;
            }
            else if (project?.LatestRunId == run.Id)
            {
                await _db.VideoProjects.UpdateOneAsync(
                    item => item.Id == run.ProjectId
                            && item.OwnerAdminId == ownerAdminId
                            && item.AppKey == run.AppKey,
                    Builders<VideoProject>.Update
                        .Unset(item => item.LatestRunId)
                        .Unset(item => item.LatestExportTaskId)
                        .Set(item => item.Status, VideoProjectStatus.Draft)
                        .Set(item => item.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: cleanupToken);
            }
        }

        return new DeleteVideoGenRunResult(true, projectDeleted, deletedArtifacts);
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

    private static IReadOnlyList<GeneratedVideoArtifact> CollectGeneratedVideoArtifacts(VideoGenRun run)
    {
        var bySha = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
        Add(run.VideoAssetSha256, run.VideoAssetUrl);
        foreach (var version in run.Scenes.SelectMany(scene => scene.Versions))
            Add(version.AssetSha256, version.VideoUrl);
        return bySha.Select(item => new GeneratedVideoArtifact(item.Key, item.Value.ToList())).ToList();

        void Add(string? storedSha, string? url)
        {
            var sha = NormalizeGeneratedVideoSha(storedSha) ?? ExtractGeneratedVideoSha(url);
            if (sha == null) return;
            if (!bySha.TryGetValue(sha, out var urls))
            {
                urls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                bySha[sha] = urls;
            }
            if (!string.IsNullOrWhiteSpace(url)) urls.Add(url.Trim());
        }
    }

    private static string? NormalizeGeneratedVideoSha(string? value)
    {
        var sha = (value ?? string.Empty).Trim().ToLowerInvariant();
        return sha.Length == 64 && sha.All(Uri.IsHexDigit) ? sha : null;
    }

    private static string? ExtractGeneratedVideoSha(string? value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return null;
        return NormalizeGeneratedVideoSha(Path.GetFileNameWithoutExtension(uri.AbsolutePath));
    }

    private sealed record GeneratedVideoArtifact(string Sha256, IReadOnlyList<string> Urls);

    private static void AddReopenEditingUpdates(List<UpdateDefinition<VideoGenRun>> updates)
    {
        updates.Add(Builders<VideoGenRun>.Update.Set(x => x.Status, VideoGenRunStatus.Editing));
        updates.Add(Builders<VideoGenRun>.Update.Set(x => x.CurrentPhase, "editing"));
        updates.Add(Builders<VideoGenRun>.Update.Set(x => x.PhaseProgress, 100));
        updates.Add(Builders<VideoGenRun>.Update.Set(x => x.VideoAssetUrl, (string?)null));
        updates.Add(Builders<VideoGenRun>.Update.Set(x => x.ExportedAt, (DateTime?)null));
        updates.Add(Builders<VideoGenRun>.Update.Set(x => x.EndedAt, (DateTime?)null));
    }

    private static string NormalizeTitle(string? title, string source)
    {
        var value = (title ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(value)) return value[..Math.Min(value.Length, 120)];
        if (string.IsNullOrWhiteSpace(source)) return "未命名视频";
        var firstLine = source.Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim().TrimStart('#').Trim();
        return string.IsNullOrWhiteSpace(firstLine)
            ? "未命名视频"
            : firstLine[..Math.Min(firstLine.Length, 60)];
    }

    private static string? NormalizeOptional(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static int NormalizeDuration(int? duration)
        => duration is >= 1 and <= 60 ? duration.Value : 5;

    private static string NormalizeAspectRatio(string? aspectRatio)
    {
        var value = (aspectRatio ?? "16:9").Trim();
        return value is "16:9" or "9:16" or "1:1" or "4:3" or "3:4" or "21:9" or "9:21" ? value : "16:9";
    }

    private static string NormalizeResolution(string? resolution, string fallback)
    {
        var value = (resolution ?? fallback).Trim();
        return value is "480p" or "720p" or "1080p" or "1K" or "2K" or "4K" ? value : fallback;
    }

    private static List<VideoProjectAsset> NormalizeAssets(IReadOnlyCollection<VideoProjectAsset>? assets)
    {
        return (assets ?? [])
            .Take(100)
            .Select(asset => new VideoProjectAsset
            {
                Id = string.IsNullOrWhiteSpace(asset.Id) ? Guid.NewGuid().ToString("N") : asset.Id.Trim(),
                Type = asset.Type is VideoProjectAssetType.Character or VideoProjectAssetType.Scene or VideoProjectAssetType.Prop or VideoProjectAssetType.Audio
                    ? asset.Type
                    : VideoProjectAssetType.Scene,
                Name = (asset.Name ?? string.Empty).Trim()[..Math.Min((asset.Name ?? string.Empty).Trim().Length, 120)],
                Url = LimitOptional(asset.Url, 2_000),
                Description = LimitOptional(asset.Description, 1_000),
                CreatedAt = asset.CreatedAt == default ? DateTime.UtcNow : asset.CreatedAt,
            })
            .Where(asset => !string.IsNullOrWhiteSpace(asset.Name))
            .ToList();
    }

    private static List<VideoTimelineTrack> NormalizeTimelineTracks(IReadOnlyCollection<VideoTimelineTrack>? tracks)
    {
        var source = tracks ?? [];
        var definitions = new[]
        {
            (Type: VideoTrackType.Video, Name: "视频"),
            (Type: VideoTrackType.Subtitle, Name: "字幕"),
            (Type: VideoTrackType.Voice, Name: "配音"),
            (Type: VideoTrackType.Music, Name: "音乐"),
        };
        return definitions.Select(definition =>
        {
            var input = source.FirstOrDefault(track => track.Type == definition.Type);
            return new VideoTimelineTrack
            {
                Id = string.IsNullOrWhiteSpace(input?.Id) ? Guid.NewGuid().ToString("N") : input.Id.Trim(),
                Type = definition.Type,
                Name = definition.Name,
                Muted = input?.Muted ?? false,
                Locked = input?.Locked ?? false,
                Clips = (input?.Clips ?? [])
                    .Take(500)
                    .Select(clip => new VideoTimelineClip
                    {
                        Id = string.IsNullOrWhiteSpace(clip.Id) ? Guid.NewGuid().ToString("N") : clip.Id.Trim(),
                        SceneIndex = clip.SceneIndex is >= 0 ? clip.SceneIndex : null,
                        StartSeconds = Math.Clamp(clip.StartSeconds, 0, 86_400),
                        DurationSeconds = Math.Clamp(clip.DurationSeconds, 0.1, 3_600),
                        TrimStartSeconds = Math.Clamp(clip.TrimStartSeconds, 0, 3_600),
                        TrimEndSeconds = Math.Clamp(clip.TrimEndSeconds, 0, 3_600),
                        AssetUrl = LimitOptional(clip.AssetUrl, 2_000),
                        Text = LimitOptional(clip.Text, 2_000),
                        Transition = clip.Transition == "fade" ? "fade" : null,
                    })
                    .ToList(),
            };
        }).ToList();
    }

    private static string? LimitOptional(string? value, int maxLength)
    {
        var normalized = NormalizeOptional(value);
        return normalized == null ? null : normalized[..Math.Min(normalized.Length, maxLength)];
    }
}
