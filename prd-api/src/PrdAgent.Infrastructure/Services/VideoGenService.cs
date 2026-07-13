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
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<VideoGenService> _logger;

    public VideoGenService(
        MongoDbContext db,
        IRunEventStore runStore,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<VideoGenService> logger)
    {
        _db = db;
        _runStore = runStore;
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
            Assets = request?.Assets ?? new List<VideoProjectAsset>(),
        };
        if (request?.TimelineTracks?.Count > 0) project.TimelineTracks = request.TimelineTracks;
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
        if (request.Assets != null) updates.Add(Builders<VideoProject>.Update.Set(x => x.Assets, request.Assets));
        if (request.TimelineTracks != null) updates.Add(Builders<VideoProject>.Update.Set(x => x.TimelineTracks, request.TimelineTracks));

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

        var updates = new List<UpdateDefinition<VideoGenRun>>
        {
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Status", SceneItemStatus.Rendering),
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.ErrorMessage", (string?)null),
        };
        if (run.Status == VideoGenRunStatus.Completed) AddReopenEditingUpdates(updates);
        await _db.VideoGenRuns.UpdateOneAsync(x => x.Id == runId,
            Builders<VideoGenRun>.Update.Combine(updates),
            cancellationToken: ct);
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

        var updates = new List<UpdateDefinition<VideoGenRun>>();
        for (var index = 0; index < run.Scenes.Count; index++)
        {
            var scene = run.Scenes[index];
            if (requested != null && !requested.Contains(index)) continue;
            if (scene.Status is SceneItemStatus.Done or SceneItemStatus.Rendering or SceneItemStatus.Generating) continue;

            updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{index}.Status", SceneItemStatus.Rendering));
            updates.Add(Builders<VideoGenRun>.Update.Set($"Scenes.{index}.ErrorMessage", (string?)null));
        }

        if (updates.Count == 0) return 0;
        var count = updates.Count / 2;
        if (run.Status == VideoGenRunStatus.Completed) AddReopenEditingUpdates(updates);
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update.Combine(updates),
            cancellationToken: ct);
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

    public async Task RequestExportAsync(
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

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Rendering)
                .Set(x => x.ExportRequested, true)
                .Set(x => x.ExportErrorMessage, (string?)null)
                .Set(x => x.CurrentPhase, "export-queued")
                .Set(x => x.PhaseProgress, 1),
            cancellationToken: ct);
        await PublishEventAsync(runId, "export.queued", new { sceneCount = run.Scenes.Count });
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
}
