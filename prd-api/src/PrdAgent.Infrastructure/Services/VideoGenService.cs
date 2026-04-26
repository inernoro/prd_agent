using System.Text;
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
        var renderMode = (request?.RenderMode ?? VideoRenderMode.Remotion).Trim().ToLowerInvariant();
        if (renderMode is not (VideoRenderMode.Remotion or VideoRenderMode.VideoGen))
            renderMode = VideoRenderMode.Remotion;

        var outputFormat = (request?.OutputFormat ?? "mp4").Trim().ToLowerInvariant();
        if (outputFormat is not ("mp4" or "html")) outputFormat = "mp4";

        // ─── 分支：videogen 直出模式（跳过分镜，直接调外部视频模型） ───
        if (renderMode == VideoRenderMode.VideoGen)
        {
            var prompt = (request?.DirectPrompt ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(prompt))
                throw new ArgumentException("直出模式下 directPrompt 不能为空");
            if (prompt.Length > 4000)
                throw new ArgumentException("prompt 超过 4000 字限制");

            var duration = request?.DirectDuration ?? 5;
            if (duration < 1 || duration > 60) duration = 5;

            var aspect = (request?.DirectAspectRatio ?? "16:9").Trim();
            if (aspect is not ("16:9" or "9:16" or "1:1" or "4:3" or "3:4" or "21:9" or "9:21")) aspect = "16:9";

            var resolution = (request?.DirectResolution ?? "720p").Trim();
            if (resolution is not ("480p" or "720p" or "1080p" or "1K" or "2K" or "4K")) resolution = "720p";

            var model = (request?.DirectVideoModel ?? "alibaba/wan-2.6").Trim();

            var directRun = new VideoGenRun
            {
                AppKey = appKey,
                OwnerAdminId = ownerAdminId,
                Status = VideoGenRunStatus.Queued,
                ArticleMarkdown = prompt, // 兼容：将 prompt 存进 ArticleMarkdown 便于列表展示
                ArticleTitle = !string.IsNullOrWhiteSpace(request?.ArticleTitle)
                    ? request!.ArticleTitle!.Trim()
                    : (prompt.Length > 60 ? prompt[..60] + "…" : prompt),
                OutputFormat = outputFormat,
                RenderMode = VideoRenderMode.VideoGen,
                DirectPrompt = prompt,
                DirectVideoModel = model,
                DirectAspectRatio = aspect,
                DirectResolution = resolution,
                DirectDuration = duration,
                CurrentPhase = "submitting",
                CreatedAt = DateTime.UtcNow
            };

            await _db.VideoGenRuns.InsertOneAsync(directRun, cancellationToken: ct);
            _logger.LogInformation("VideoGen Run 已创建（videogen 模式）: runId={RunId}, model={Model}, duration={Duration}s, aspect={Aspect}",
                directRun.Id, model, duration, aspect);
            return directRun.Id;
        }

        // ─── 默认分支：remotion（原流程） ───
        var inputSourceType = (request?.InputSourceType ?? VideoInputSourceType.Article).Trim().ToLowerInvariant();
        if (inputSourceType is not (VideoInputSourceType.Article or VideoInputSourceType.Prd))
            inputSourceType = VideoInputSourceType.Article;

        var attachmentIds = (request?.AttachmentIds ?? new List<string>())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim())
            .Distinct()
            .ToList();

        var markdown = (request?.ArticleMarkdown ?? string.Empty).Trim();

        // PRD 模式：允许 markdown 为空，从附件提取
        if (string.IsNullOrWhiteSpace(markdown) && attachmentIds.Count > 0)
        {
            var extracted = await BuildMarkdownFromAttachmentsAsync(attachmentIds, ownerAdminId, ct);
            markdown = extracted.Markdown;
            if (string.IsNullOrWhiteSpace(markdown))
                throw new ArgumentException("所选附件未能提取到可用文本，请换一份文档或粘贴文本");
            // 若用户没指定标题，用首个附件名兜底
            if (string.IsNullOrWhiteSpace(request?.ArticleTitle) && !string.IsNullOrWhiteSpace(extracted.Title))
            {
                request!.ArticleTitle = extracted.Title;
            }
        }

        if (string.IsNullOrWhiteSpace(markdown))
            throw new ArgumentException("文章内容不能为空");

        if (markdown.Length > 100_000)
        {
            // PRD/长文档截断而不是报错，避免用户上传大文档直接失败
            markdown = markdown[..100_000];
            _logger.LogWarning("VideoGen 输入超过 10 万字，已截断: appKey={AppKey}", appKey);
        }

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
            AutoRender = request?.AutoRender ?? false,
            OutputFormat = outputFormat,
            EnableTts = request?.EnableTts ?? false,
            VoiceId = request?.VoiceId?.Trim(),
            RenderMode = VideoRenderMode.Remotion,
            InputSourceType = inputSourceType,
            AttachmentIds = attachmentIds,
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

        // 分镜级渲染模式覆盖：空字符串 = 清除覆盖（回到跟随 Run），其他 = 设置为该值
        if (request.RenderMode != null)
        {
            var trimmed = request.RenderMode.Trim();
            scene.RenderMode = string.IsNullOrEmpty(trimmed) ? null : trimmed;
        }
        if (request.DirectPrompt != null) scene.DirectPrompt = string.IsNullOrWhiteSpace(request.DirectPrompt) ? null : request.DirectPrompt.Trim();
        if (request.DirectVideoModel != null) scene.DirectVideoModel = string.IsNullOrWhiteSpace(request.DirectVideoModel) ? null : request.DirectVideoModel.Trim();
        if (request.DirectAspectRatio != null) scene.DirectAspectRatio = string.IsNullOrWhiteSpace(request.DirectAspectRatio) ? null : request.DirectAspectRatio.Trim();
        if (request.DirectResolution != null) scene.DirectResolution = string.IsNullOrWhiteSpace(request.DirectResolution) ? null : request.DirectResolution.Trim();
        if (request.DirectDuration.HasValue) scene.DirectDuration = request.DirectDuration.Value > 0 ? request.DirectDuration : null;

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

        // 使用位置索引更新，避免并发批量请求时整组覆盖导致的竞态
        var update = Builders<VideoGenRun>.Update
            .Set($"Scenes.{sceneIndex}.ImageStatus", "running")
            .Set($"Scenes.{sceneIndex}.ImageUrl", (string?)null);

        await _db.VideoGenRuns.UpdateOneAsync(x => x.Id == runId, update, cancellationToken: ct);

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

        // 使用位置索引更新，避免并发批量请求时整组覆盖导致的竞态
        var update = Builders<VideoGenRun>.Update
            .Set($"Scenes.{sceneIndex}.BackgroundImageStatus", "running")
            .Set($"Scenes.{sceneIndex}.BackgroundImageUrl", (string?)null);

        await _db.VideoGenRuns.UpdateOneAsync(x => x.Id == runId, update, cancellationToken: ct);

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

    public async Task RequestSceneAudioAsync(string runId, string ownerAdminId, int sceneIndex, string? appKey = null, CancellationToken ct = default)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.Eq(x => x.Id, runId) & fb.Eq(x => x.OwnerAdminId, ownerAdminId)
                   & fb.Eq(x => x.Status, VideoGenRunStatus.Editing);
        if (appKey != null) filter &= fb.Eq(x => x.AppKey, appKey);

        var update = Builders<VideoGenRun>.Update
            .Set($"Scenes.{sceneIndex}.AudioStatus", "running")
            .Set($"Scenes.{sceneIndex}.AudioErrorMessage", (string?)null);

        var res = await _db.VideoGenRuns.UpdateOneAsync(filter, update, cancellationToken: ct);
        if (res.MatchedCount == 0) throw new InvalidOperationException("Run not found or not in Editing phase");

        await PublishEventAsync(runId, "scene.audio.queued", new { sceneIndex });
    }

    public async Task RequestAllAudioAsync(string runId, string ownerAdminId, string? appKey = null, CancellationToken ct = default)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.Eq(x => x.Id, runId) & fb.Eq(x => x.OwnerAdminId, ownerAdminId)
                   & fb.Eq(x => x.Status, VideoGenRunStatus.Editing);
        if (appKey != null) filter &= fb.Eq(x => x.AppKey, appKey);

        var run = await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(ct);
        if (run == null) throw new InvalidOperationException("Run not found or not in Editing phase");

        // 批量设置所有场景的 audioStatus 为 running
        var updates = new List<UpdateDefinition<VideoGenRun>>();
        for (int i = 0; i < run.Scenes.Count; i++)
        {
            if (string.IsNullOrEmpty(run.Scenes[i].Narration)) continue;
            updates.Add(Builders<VideoGenRun>.Update
                .Set($"Scenes.{i}.AudioStatus", "running")
                .Set($"Scenes.{i}.AudioErrorMessage", (string?)null));
        }

        if (updates.Count > 0)
        {
            var combined = Builders<VideoGenRun>.Update.Combine(updates);
            combined = combined.Set(x => x.EnableTts, true);
            await _db.VideoGenRuns.UpdateOneAsync(fb.Eq(x => x.Id, runId), combined, cancellationToken: ct);
        }

        await PublishEventAsync(runId, "audio.all.queued", new { sceneCount = updates.Count });
    }

    public async Task UpdateRunRenderModeAsync(string runId, string ownerAdminId, string mode, bool applyToAll, string? appKey = null, CancellationToken ct = default)
    {
        // 校验模式合法性
        if (mode != VideoRenderMode.Remotion && mode != VideoRenderMode.VideoGen)
            throw new InvalidOperationException($"不支持的渲染模式: {mode}");

        var run = await GetRunAsync(runId, ownerAdminId, appKey, ct)
                  ?? throw new KeyNotFoundException("任务不存在");

        // 仅 Editing 阶段可切换默认模式（Rendering / Completed 不允许）
        if (run.Status != VideoGenRunStatus.Editing)
            throw new InvalidOperationException("仅在编辑阶段可切换渲染模式");

        var update = Builders<VideoGenRun>.Update.Set(x => x.RenderMode, mode);

        if (applyToAll)
        {
            // 把所有分镜的 RenderMode 显式覆盖为该模式（用户主动选了"应用到全部"，
            // 历史的 per-scene 覆盖也会被洗掉）
            for (int i = 0; i < run.Scenes.Count; i++)
            {
                update = update.Set($"Scenes.{i}.RenderMode", mode);
            }
        }

        await _db.VideoGenRuns.UpdateOneAsync(x => x.Id == runId, update, cancellationToken: ct);

        await PublishEventAsync(runId, "render.mode.changed", new { mode, applyToAll });

        _logger.LogInformation("VideoGen 渲染模式切换: runId={RunId}, mode={Mode}, applyToAll={Apply}",
            runId, mode, applyToAll);
    }

    private async Task<(string Markdown, string? Title)> BuildMarkdownFromAttachmentsAsync(
        List<string> attachmentIds, string ownerAdminId, CancellationToken ct)
    {
        if (attachmentIds.Count == 0) return (string.Empty, null);

        var fb = Builders<Attachment>.Filter;
        var filter = fb.In(a => a.AttachmentId, attachmentIds) & fb.Eq(a => a.UploaderId, ownerAdminId);
        var atts = await _db.Attachments.Find(filter).ToListAsync(ct);

        if (atts.Count == 0)
            throw new ArgumentException("附件不存在或无权访问");

        // 按请求顺序排序
        var ordered = attachmentIds
            .Select(id => atts.FirstOrDefault(a => a.AttachmentId == id))
            .Where(a => a != null)
            .ToList();

        var sb = new StringBuilder();
        string? firstTitle = null;
        foreach (var att in ordered)
        {
            var text = (att!.ExtractedText ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(text)) continue;

            if (sb.Length > 0) sb.AppendLine().AppendLine("---").AppendLine();
            sb.AppendLine($"# {att.FileName}");
            sb.AppendLine();
            sb.AppendLine(text);

            if (firstTitle == null)
            {
                // 去掉扩展名作为兜底标题
                var dot = att.FileName.LastIndexOf('.');
                firstTitle = dot > 0 ? att.FileName[..dot] : att.FileName;
            }
        }

        return (sb.ToString(), firstTitle);
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
