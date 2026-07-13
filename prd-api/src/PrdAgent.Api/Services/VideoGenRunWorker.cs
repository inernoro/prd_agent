using System.Text.Json.Nodes;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Globalization;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 视频生成与项目导出后台执行器。
///
/// 架构：用户提交 prompt → Worker 调 OpenRouter Veo/Kling/Wan/Sora → 拿到视频 URL →
/// 用 API Key 鉴权下载视频二进制 → 上传到 COS → 把 COS 公开 URL 写回 Run.VideoAssetUrl
///
/// storyboard 模式先经 LLM 拆镜，再逐镜调用模型池，并由 ffmpeg 按项目时间线合成音视频和字幕。
/// </summary>
public class VideoGenRunWorker : BackgroundService
{
    private readonly MongoDbContext _db;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IRunEventStore _runStore;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<VideoGenRunWorker> _logger;

    public VideoGenRunWorker(
        MongoDbContext db,
        IServiceScopeFactory scopeFactory,
        IRunEventStore runStore,
        IAssetStorage assetStorage,
        ILogger<VideoGenRunWorker> logger)
    {
        _db = db;
        _scopeFactory = scopeFactory;
        _runStore = runStore;
        _assetStorage = assetStorage;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // 路径 1: Queued → 根据 Mode 路由
                //   - direct      → 直接走 ProcessDirectVideoGenAsync (Rendering)
                //   - storyboard  → 走 ProcessScriptingAsync 拆分镜 (Scripting → Editing)
                var queued = await ClaimQueuedRunAsync(stoppingToken);
                if (queued != null)
                {
                    _logger.LogInformation("[VideoGenWorker] Claimed run: runId={RunId}, mode={Mode}",
                        queued.Id, queued.Mode);
                    try
                    {
                        if (queued.Mode == VideoGenMode.Storyboard)
                            await ProcessStoryboardScriptingAsync(queued);
                        else
                            await ProcessDirectVideoGenAsync(queued);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGen 任务失败: runId={RunId}", queued.Id);
                        await FailRunAsync(queued, "VIDEOGEN_ERROR", ex.Message);
                    }
                    continue;
                }

                // 路径 2: Editing 状态有 scene.Status==Rendering → 调 OpenRouter 单镜生成
                var sceneRun = await FindEditingRunWithSceneRenderingAsync(stoppingToken);
                if (sceneRun != null)
                {
                    try
                    {
                        await ProcessSceneRenderAsync(sceneRun);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGen 单镜渲染异常: runId={RunId}", sceneRun.Id);
                    }
                    continue;
                }

                // 路径 4: 独立导出任务，全部分镜已完成后合成为完整 MP4
                var exportTask = await ClaimExportTaskAsync(stoppingToken);
                if (exportTask != null)
                {
                    var taskRun = await _db.VideoGenRuns.Find(x => x.Id == exportTask.RunId)
                        .FirstOrDefaultAsync(stoppingToken);
                    if (taskRun == null)
                    {
                        await _db.VideoExportTasks.UpdateOneAsync(
                            x => x.Id == exportTask.Id,
                            Builders<VideoExportTask>.Update
                                .Set(x => x.Status, VideoExportTaskStatus.Failed)
                                .Set(x => x.ErrorMessage, "关联的视频生成任务不存在")
                                .Set(x => x.EndedAt, DateTime.UtcNow),
                            cancellationToken: CancellationToken.None);
                        continue;
                    }
                    try
                    {
                        await ProcessExportAsync(taskRun, exportTask);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGen 独立导出异常: runId={RunId}, taskId={TaskId}", taskRun.Id, exportTask.Id);
                        await FailExportAsync(taskRun, ex.Message, exportTask.Id);
                    }
                    continue;
                }

                // 兼容升级前仍由 ExportRequested 标记的导出任务
                var exportRun = await ClaimExportRunAsync(stoppingToken);
                if (exportRun != null)
                {
                    try
                    {
                        await ProcessExportAsync(exportRun);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGen 合成导出异常: runId={RunId}", exportRun.Id);
                        await FailExportAsync(exportRun, ex.Message);
                    }
                    continue;
                }

                // 路径 3: Editing 状态有 scene.Status==Generating → LLM 重生成单镜 prompt
                var regenRun = await FindEditingRunWithSceneGeneratingAsync(stoppingToken);
                if (regenRun != null)
                {
                    try
                    {
                        await ProcessSceneRegenerateAsync(regenRun);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGen 单镜重生成异常: runId={RunId}", regenRun.Id);
                    }
                    continue;
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "VideoGenRunWorker 主循环异常");
            }

            await Task.Delay(2000, stoppingToken);
        }
    }

    /// <summary>
    /// 拾取 Queued 任务，置为 Rendering 或 Scripting（根据 Mode）
    /// </summary>
    private async Task<VideoGenRun?> ClaimQueuedRunAsync(CancellationToken ct)
    {
        var fb = Builders<VideoGenRun>.Filter;
        // 先 peek 看下 Mode（避免错误置 status）
        var pending = await _db.VideoGenRuns.Find(fb.Eq(x => x.Status, VideoGenRunStatus.Queued))
            .FirstOrDefaultAsync(ct);
        if (pending == null) return null;

        var nextStatus = pending.Mode == VideoGenMode.Storyboard
            ? VideoGenRunStatus.Scripting
            : VideoGenRunStatus.Rendering;
        var nextPhase = pending.Mode == VideoGenMode.Storyboard
            ? "scripting"
            : "videogen-submitting";

        var update = Builders<VideoGenRun>.Update
            .Set(x => x.Status, nextStatus)
            .Set(x => x.StartedAt, DateTime.UtcNow)
            .Set(x => x.CurrentPhase, nextPhase)
            .Set(x => x.PhaseProgress, 1);

        var run = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            fb.Eq(x => x.Status, VideoGenRunStatus.Queued),
            update,
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
        return run;
    }

    /// <summary>
    /// OpenRouter 直出：提交 → 轮询 → 写回 VideoAssetUrl → Completed
    /// 使用 CancellationToken.None（服务器权威原则）
    ///
    /// AppCallerCode = "video-agent.videogen::video-gen" 决定模型池，
    /// 平台 ApiKey 从平台管理中配置的凭据自动取用，不依赖环境变量。
    /// </summary>
    private async Task ProcessDirectVideoGenAsync(VideoGenRun run)
    {
        // 领取前已请求取消（claim 仅过滤 Status==Queued、不看 CancelRequested）：直接置终态，不进入提交流程（Codex review）
        if (run.CancelRequested) { await CancelRunAsync(run); return; }

        // 按 run.AppKey 选 caller：视觉分镜台(visual-agent)创建的 run 归属 visual-agent 视频配额/模型池与日志归因，
        // 不再一律记到 video-agent（Codex review，配合前端改走 /api/visual-agent/video-gen）。
        var appCallerCode = run.AppKey == "visual-agent"
            ? AppCallerRegistry.VisualAgent.VideoGen.Generate
            : AppCallerRegistry.VideoAgent.VideoGen.Generate;

        _logger.LogInformation("VideoGen 直出开始: runId={RunId}, userModel={Model}, duration={Duration}s",
            run.Id, run.DirectVideoModel, run.DirectDuration);

        await PublishEventAsync(run.Id, "phase.changed", new { phase = "videogen-submitting", progress = 5 });

        using var scope = _scopeFactory.CreateScope();
        var client = scope.ServiceProvider.GetRequiredService<IOpenRouterVideoClient>();
        var ctxAccessor = scope.ServiceProvider.GetRequiredService<ILLMRequestContextAccessor>();

        // ─── 提交任务 ───
        var prompt = run.DirectPrompt ?? string.Empty;
        if (string.IsNullOrWhiteSpace(prompt))
        {
            await FailRunAsync(run, "EMPTY_PROMPT", "directPrompt 为空，无法生成视频");
            return;
        }
        var directProject = await GetRunProjectAsync(run);
        prompt = AppendAssetConstraints(prompt, directProject);
        var directReferences = await SupportsReferenceAssetsAsync(run.DirectVideoModel)
            ? GetReferenceImageUrls(directProject)
            : [];

        var submitReq = new OpenRouterVideoSubmitRequest
        {
            AppCallerCode = appCallerCode,
            Model = run.DirectVideoModel, // 用户偏好（可空）；由模型池决定最终选择
            Prompt = prompt,
            FirstFrameImageUrl = run.DirectFirstFrameUrl, // 设置则走图生视频（视觉分镜台「动起来」）
            ReferenceImageUrls = directReferences,
            AspectRatio = run.DirectAspectRatio,
            Resolution = run.DirectResolution,
            DurationSeconds = run.DirectDuration,
            GenerateAudio = run.GenerateAudio,
            UserId = run.OwnerAdminId,
            RequestId = run.Id
        };

        // 提交前最后一道闸：领取后、提交到 OpenRouter 之前若收到取消请求（用户重新生成分镜 / 离开页面），
        // 置终态不提交，避免烧视频额度。覆盖「claim 与 submit 之间」的取消窗口（Codex review）。
        var freshBeforeSubmit = await _db.VideoGenRuns.Find(x => x.Id == run.Id).FirstOrDefaultAsync(CancellationToken.None);
        if (freshBeforeSubmit?.CancelRequested == true) { await CancelRunAsync(run); return; }

        using var _ = ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: run.Id,
            GroupId: null,
            SessionId: run.Id,
            UserId: run.OwnerAdminId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[VIDEO_GEN_DIRECT]",
            RequestType: ModelTypes.VideoGen,
            AppCallerCode: appCallerCode,
            ForceFullShadowSample: run.ForceFullShadowSample));

        var submitResult = await client.SubmitAsync(submitReq, CancellationToken.None);
        if (!submitResult.Success || string.IsNullOrWhiteSpace(submitResult.JobId))
        {
            await FailRunAsync(run, "OPENROUTER_SUBMIT_FAILED",
                submitResult.ErrorMessage ?? "OpenRouter 提交失败");
            return;
        }

        // 把 Gateway 解析出来的实际模型 id 回写到 Run
        if (!string.IsNullOrWhiteSpace(submitResult.ActualModel))
        {
            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update.Set(x => x.DirectVideoModel, submitResult.ActualModel),
                cancellationToken: CancellationToken.None);
        }

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.DirectVideoJobId, submitResult.JobId)
                .Set(x => x.CurrentPhase, "videogen-polling")
                .Set(x => x.PhaseProgress, 10),
            cancellationToken: CancellationToken.None);

        await PublishEventAsync(run.Id, "phase.changed",
            new { phase = "videogen-polling", progress = 10, jobId = submitResult.JobId });

        // ─── 轮询 ───
        const int pollIntervalSec = 6;
        const int maxWaitMinutes = 10;
        var deadline = DateTime.UtcNow.AddMinutes(maxWaitMinutes);
        var progress = 10;

        while (DateTime.UtcNow < deadline)
        {
            // 用户取消
            var fresh = await _db.VideoGenRuns.Find(x => x.Id == run.Id).FirstOrDefaultAsync(CancellationToken.None);
            if (fresh?.CancelRequested == true)
            {
                await CancelRunAsync(run);
                return;
            }

            await Task.Delay(TimeSpan.FromSeconds(pollIntervalSec), CancellationToken.None);

            OpenRouterVideoStatus status;
            try
            {
                status = await client.GetStatusAsync(appCallerCode, submitResult.JobId!, CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "VideoGen 轮询异常（继续等待）: runId={RunId}", run.Id);
                continue;
            }

            if (status.IsCompleted && !string.IsNullOrWhiteSpace(status.VideoUrl))
            {
                // 关键：OpenRouter URL 需 API Key 鉴权才能播放，浏览器无法直接 <video src>。
                // 必须下载到 COS / R2 后用公开 URL 替换。
                _logger.LogInformation("VideoGen 直出渲染完成，下载到 COS: runId={RunId}, openrouterUrl={Url}",
                    run.Id, status.VideoUrl);

                await _db.VideoGenRuns.UpdateOneAsync(
                    x => x.Id == run.Id,
                    Builders<VideoGenRun>.Update
                        .Set(x => x.CurrentPhase, "downloading")
                        .Set(x => x.PhaseProgress, 95),
                    cancellationToken: CancellationToken.None);

                await PublishEventAsync(run.Id, "phase.changed", new { phase = "downloading", progress = 95 });

                string finalUrl;
                try
                {
                    var dl = await client.DownloadVideoBytesAsync(appCallerCode, submitResult.JobId!, 0, CancellationToken.None);
                    if (!dl.Success || dl.Bytes == null || dl.Bytes.Length == 0)
                    {
                        await FailRunAsync(run, "DOWNLOAD_FAILED",
                            $"OpenRouter 视频下载失败: {dl.ErrorMessage ?? "二进制为空"}");
                        return;
                    }

                    RegistryAssetStorage.OverrideNextScope("generated");
                    var stored = await _assetStorage.SaveAsync(
                        dl.Bytes, dl.ContentType ?? "video/mp4", CancellationToken.None,
                        domain: AppDomainPaths.DomainVideoAgent, type: AppDomainPaths.TypeVideo);
                    finalUrl = stored.Url;

                    _logger.LogInformation("VideoGen 视频已上传 COS: runId={RunId}, url={Url}, size={Size}",
                        run.Id, finalUrl, stored.SizeBytes);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "VideoGen 下载/上传失败: runId={RunId}", run.Id);
                    await FailRunAsync(run, "DOWNLOAD_FAILED", $"视频下载或上传 COS 失败: {ex.Message}");
                    return;
                }

                await _db.VideoGenRuns.UpdateOneAsync(
                    x => x.Id == run.Id,
                    Builders<VideoGenRun>.Update
                        .Set(x => x.Status, VideoGenRunStatus.Completed)
                        .Set(x => x.VideoAssetUrl, finalUrl)
                        .Set(x => x.DirectVideoCost, status.Cost)
                        .Set(x => x.CurrentPhase, "completed")
                        .Set(x => x.PhaseProgress, 100)
                        .Set(x => x.EndedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
                await UpdateProjectAsync(run, VideoProjectStatus.Completed);

                await PublishEventAsync(run.Id, "run.completed", new
                {
                    videoUrl = finalUrl,
                    cost = status.Cost
                });

                _logger.LogInformation("VideoGen 直出完成: runId={RunId}, finalUrl={Url}, cost=${Cost}",
                    run.Id, finalUrl, status.Cost);
                return;
            }

            if (status.IsFailed)
            {
                await FailRunAsync(run, "OPENROUTER_GEN_FAILED",
                    status.ErrorMessage ?? $"OpenRouter 状态 = {status.Status}");
                return;
            }

            // 递增进度（保持用户感知到"在动"）
            progress = Math.Min(90, progress + 3);
            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update.Set(x => x.PhaseProgress, progress),
                cancellationToken: CancellationToken.None);
            await PublishEventAsync(run.Id, "phase.progress",
                new { phase = "videogen-polling", progress, status = status.Status });
        }

        await FailRunAsync(run, "OPENROUTER_TIMEOUT", $"视频生成超过 {maxWaitMinutes} 分钟未完成");
    }

    private async Task FailRunAsync(VideoGenRun run, string errorCode, string errorMessage)
    {
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Failed)
                .Set(x => x.ErrorCode, errorCode)
                .Set(x => x.ErrorMessage, errorMessage)
                .Set(x => x.EndedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        await UpdateProjectAsync(run, VideoProjectStatus.Draft);

        await PublishEventAsync(run.Id, "run.error", new { code = errorCode, message = errorMessage });
    }

    private async Task CancelRunAsync(VideoGenRun run)
    {
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Cancelled)
                .Set(x => x.EndedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        await UpdateProjectAsync(run, VideoProjectStatus.Draft);

        await PublishEventAsync(run.Id, "run.cancelled", new { });
        _logger.LogInformation("VideoGen 已取消: runId={RunId}", run.Id);
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

    // ═══════════════════════════════════════════════════════════
    // Storyboard 模式：拆分镜 → 用户编辑 → 逐镜调 OpenRouter
    // ═══════════════════════════════════════════════════════════

    private const string StoryboardScriptingPrompt =
        @"你是视频导演。请基于用户提供的文章/PRD：
1. 给整段视频取一个吸引人的中文标题（不超过 14 字）
2. 拆解为 3-8 个适合短视频生成的分镜，每个 5-10 秒，能用一句话英文 prompt 喂给视频大模型（Veo / Kling / Wan / Sora）生成

输出 JSON 对象，schema：
{
  ""title"": ""整段视频中文标题"",
  ""scenes"": [
    {
      ""topic"": ""中文小标题，6 字内"",
      ""prompt"": ""英文视频生成 prompt，描述画面内容、镜头语言、风格、光影"",
      ""duration"": 5
    }
  ]
}

要求：
- 整段视频不超过 60 秒（所有 duration 之和）
- 每段 prompt 独立可读，不依赖前后文
- 风格保持一致（用户可能在 styleDescription 里指定，要融入每段 prompt）
- 不要写解释、不要包 markdown 代码块，直接输出 JSON

只输出 JSON。";

    private async Task ProcessStoryboardScriptingAsync(VideoGenRun run)
    {
        if (run.CancelRequested) { await CancelRunAsync(run); return; }

        if (string.IsNullOrWhiteSpace(run.ArticleMarkdown))
        {
            await FailRunAsync(run, "EMPTY_ARTICLE", "storyboard 模式需要 articleMarkdown");
            return;
        }

        await UpdatePhaseAsync(run, "scripting", 10);
        await PublishEventAsync(run.Id, "phase.changed", new { phase = "scripting", progress = 10 });

        using var scope = _scopeFactory.CreateScope();
        var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();
        var ctxAccessor = scope.ServiceProvider.GetRequiredService<ILLMRequestContextAccessor>();

        using var _ = ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: run.OwnerAdminId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: null,
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.VideoAgent.Script.Chat,
            ForceFullShadowSample: run.ForceFullShadowSample
        ));

        var storyboardProject = await GetRunProjectAsync(run);
        var userPrompt = string.IsNullOrWhiteSpace(run.StyleDescription)
            ? run.ArticleMarkdown
            : $"风格要求：{run.StyleDescription}\n\n文章内容：\n{run.ArticleMarkdown}";
        userPrompt = AppendAssetConstraints(userPrompt, storyboardProject);

        var requestBody = new System.Text.Json.Nodes.JsonObject
        {
            ["messages"] = new System.Text.Json.Nodes.JsonArray
            {
                new System.Text.Json.Nodes.JsonObject { ["role"] = "system", ["content"] = StoryboardScriptingPrompt },
                new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = userPrompt },
            },
            ["temperature"] = 0.7,
        };

        var resolution = await gateway.ResolveModelAsync(
            AppCallerRegistry.VideoAgent.Script.Chat, ModelTypes.Chat, null, ct: CancellationToken.None);
        if (!resolution.Success)
        {
            await FailRunAsync(run, "MODEL_RESOLVE_FAILED", $"模型调度失败: {resolution.ErrorMessage}");
            return;
        }

        var resp = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.Script.Chat,
            ModelType = ModelTypes.Chat,
            RequestBody = requestBody,
            TimeoutSeconds = 120,
        }, resolution, CancellationToken.None);

        if (!resp.Success || string.IsNullOrWhiteSpace(resp.Content))
        {
            await FailRunAsync(run, "LLM_FAILED", $"拆分镜 LLM 调用失败: {resp.ErrorCode}");
            return;
        }

        // 解析 LLM 返回（OpenAI chat completions 格式）
        var llmText = ExtractAssistantText(resp.Content);
        var (aiTitle, scenes) = ParseScenesFromLlmResponse(llmText, run);
        if (scenes.Count == 0)
        {
            await FailRunAsync(run, "PARSE_FAILED", "LLM 返回无法解析为分镜数组");
            return;
        }

        var totalDuration = scenes.Sum(s => s.Duration ?? run.DirectDuration ?? 5);

        // 构建 update：scenes / 状态 + 仅当 LLM 给出 title 且当前 ArticleTitle 是默认截断（来自首句）时覆盖
        var update = Builders<VideoGenRun>.Update
            .Set(x => x.Scenes, scenes)
            .Set(x => x.TotalDurationSeconds, totalDuration)
            .Set(x => x.Status, VideoGenRunStatus.Editing)
            .Set(x => x.CurrentPhase, "editing")
            .Set(x => x.PhaseProgress, 100);

        if (!string.IsNullOrWhiteSpace(aiTitle))
        {
            var cleanTitle = aiTitle!.Trim();
            if (cleanTitle.Length > 60) cleanTitle = cleanTitle[..60];
            update = update.Set(x => x.ArticleTitle, cleanTitle);
        }

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            update,
            cancellationToken: CancellationToken.None);

        await SyncProjectStoryboardAsync(run, scenes, aiTitle);

        await PublishEventAsync(run.Id, "scenes.generated",
            new { count = scenes.Count, totalDuration });
        _logger.LogInformation("VideoGen storyboard 拆分镜完成: runId={RunId}, scenes={Count}", run.Id, scenes.Count);
    }

    private static string ExtractAssistantText(string apiResponseJson)
    {
        try
        {
            var doc = System.Text.Json.Nodes.JsonNode.Parse(apiResponseJson)?.AsObject();
            var content = doc?["choices"]?[0]?["message"]?["content"]?.GetValue<string>();
            return content ?? string.Empty;
        }
        catch { return apiResponseJson; }
    }

    /// <summary>
    /// 解析 LLM 返回，支持两种格式：
    ///   1) 包装对象：{ "title": "...", "scenes": [...] }
    ///   2) 兼容旧格式：直接的分镜数组 [...]
    /// 返回 (title, scenes)；title 为 null 时表示 LLM 没给。
    /// </summary>
    private static (string? Title, List<VideoGenScene> Scenes) ParseScenesFromLlmResponse(string text, VideoGenRun run)
    {
        var trimmed = text.Trim();
        if (string.IsNullOrEmpty(trimmed)) return (null, new List<VideoGenScene>());

        // 优先尝试包装对象（找最外层 { ... }）
        var objStart = trimmed.IndexOf('{');
        var objEnd = trimmed.LastIndexOf('}');
        if (objStart >= 0 && objEnd > objStart)
        {
            try
            {
                var obj = System.Text.Json.Nodes.JsonNode.Parse(trimmed[objStart..(objEnd + 1)])?.AsObject();
                var arr = obj?["scenes"]?.AsArray();
                if (arr != null)
                {
                    var title = obj?["title"]?.GetValue<string>();
                    return (title, BuildScenes(arr, run));
                }
            }
            catch { /* 继续尝试数组形式 */ }
        }

        // 兼容旧格式：纯数组
        var arrStart = trimmed.IndexOf('[');
        var arrEnd = trimmed.LastIndexOf(']');
        if (arrStart < 0 || arrEnd <= arrStart) return (null, new List<VideoGenScene>());
        try
        {
            var arr = System.Text.Json.Nodes.JsonNode.Parse(trimmed[arrStart..(arrEnd + 1)])?.AsArray();
            return (null, arr == null ? new List<VideoGenScene>() : BuildScenes(arr, run));
        }
        catch
        {
            return (null, new List<VideoGenScene>());
        }
    }

    private static List<VideoGenScene> BuildScenes(System.Text.Json.Nodes.JsonArray arr, VideoGenRun run)
    {
        var result = new List<VideoGenScene>();
        for (int i = 0; i < arr.Count; i++)
        {
            var item = arr[i]?.AsObject();
            if (item == null) continue;

            var topic = item["topic"]?.GetValue<string>() ?? $"分镜 {i + 1}";
            var prompt = item["prompt"]?.GetValue<string>() ?? string.Empty;
            int? duration = null;
            if (item["duration"]?.GetValue<int>() is int d && d > 0) duration = d;

            if (string.IsNullOrWhiteSpace(prompt)) continue;

            result.Add(new VideoGenScene
            {
                Index = i,
                Topic = topic.Trim(),
                Prompt = prompt.Trim(),
                Status = SceneItemStatus.Draft,
                Duration = duration,
                Model = run.DirectVideoModel,
                AspectRatio = run.DirectAspectRatio,
                Resolution = run.DirectResolution,
            });
        }
        return result;
    }

    /// <summary>找 Editing 状态有 scene.Status==Rendering 的 run（用户点了"生成视频"）</summary>
    private async Task<VideoGenRun?> FindEditingRunWithSceneRenderingAsync(CancellationToken ct)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.Eq(x => x.Status, VideoGenRunStatus.Editing)
                    & fb.ElemMatch(x => x.Scenes,
                        Builders<VideoGenScene>.Filter.Eq(s => s.Status, SceneItemStatus.Rendering));
        return await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(ct);
    }

    /// <summary>找 Editing 状态有 scene.Status==Generating（LLM 重生成 prompt）的 run</summary>
    private async Task<VideoGenRun?> FindEditingRunWithSceneGeneratingAsync(CancellationToken ct)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.Eq(x => x.Status, VideoGenRunStatus.Editing)
                    & fb.ElemMatch(x => x.Scenes,
                        Builders<VideoGenScene>.Filter.Eq(s => s.Status, SceneItemStatus.Generating));
        return await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(ct);
    }

    /// <summary>处理单镜渲染：调 OpenRouter，下载 mp4 到 COS，写回 Scene.VideoUrl</summary>
    private async Task ProcessSceneRenderAsync(VideoGenRun run)
    {
        var sceneIdx = run.Scenes.FindIndex(s => s.Status == SceneItemStatus.Rendering);
        if (sceneIdx < 0) return;
        var scene = run.Scenes[sceneIdx];

        // 按 run.AppKey 选 caller：视觉分镜台(visual-agent)创建的 run 归属 visual-agent 视频配额/模型池与日志归因，
        // 不再一律记到 video-agent（Codex review，配合前端改走 /api/visual-agent/video-gen）。
        var appCallerCode = run.AppKey == "visual-agent"
            ? AppCallerRegistry.VisualAgent.VideoGen.Generate
            : AppCallerRegistry.VideoAgent.VideoGen.Generate;
        _logger.LogInformation("VideoGen 单镜渲染开始: runId={RunId}, scene={Idx}, prompt={Len}字",
            run.Id, sceneIdx, scene.Prompt.Length);
        await PublishEventAsync(run.Id, "scene.render.start", new { sceneIndex = sceneIdx });

        using var scope = _scopeFactory.CreateScope();
        var client = scope.ServiceProvider.GetRequiredService<IOpenRouterVideoClient>();
        var ctxAccessor = scope.ServiceProvider.GetRequiredService<ILLMRequestContextAccessor>();

        try
        {
            var sceneProject = await GetRunProjectAsync(run);
            var sceneModel = scene.Model ?? run.DirectVideoModel;
            var submitReq = new OpenRouterVideoSubmitRequest
            {
                AppCallerCode = appCallerCode,
                Model = sceneModel,
                Prompt = AppendAssetConstraints(scene.Prompt, sceneProject),
                FirstFrameImageUrl = scene.FirstFrameUrl,
                LastFrameImageUrl = scene.LastFrameUrl,
                ReferenceImageUrls = await SupportsReferenceAssetsAsync(sceneModel)
                    ? GetReferenceImageUrls(sceneProject)
                    : [],
                AspectRatio = scene.AspectRatio ?? run.DirectAspectRatio,
                Resolution = scene.Resolution ?? run.DirectResolution,
                DurationSeconds = scene.Duration ?? run.DirectDuration,
                GenerateAudio = run.GenerateAudio,
                UserId = run.OwnerAdminId,
                RequestId = $"{run.Id}_scene_{sceneIdx}",
            };

            using var _ = ctxAccessor.BeginScope(new LlmRequestContext(
                RequestId: $"{run.Id}_scene_{sceneIdx}",
                GroupId: null,
                SessionId: run.Id,
                UserId: run.OwnerAdminId,
                ViewRole: null,
                DocumentChars: null,
                DocumentHash: null,
                SystemPromptRedacted: "[VIDEO_GEN_SCENE]",
                RequestType: ModelTypes.VideoGen,
                AppCallerCode: appCallerCode,
                ForceFullShadowSample: run.ForceFullShadowSample));

            var submitResult = await client.SubmitAsync(submitReq, CancellationToken.None);
            if (!submitResult.Success || string.IsNullOrWhiteSpace(submitResult.JobId))
            {
                await MarkSceneErrorAsync(run.Id, sceneIdx, submitResult.ErrorMessage ?? "OpenRouter 提交失败");
                return;
            }

            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIdx}.JobId", submitResult.JobId),
                cancellationToken: CancellationToken.None);
            await UpdateProjectAsync(run, VideoProjectStatus.Rendering);

            // 轮询
            const int pollIntervalSec = 6;
            const int maxWaitMinutes = 10;
            var deadline = DateTime.UtcNow.AddMinutes(maxWaitMinutes);

            while (DateTime.UtcNow < deadline)
            {
                await Task.Delay(TimeSpan.FromSeconds(pollIntervalSec), CancellationToken.None);

                var status = await client.GetStatusAsync(appCallerCode, submitResult.JobId!, CancellationToken.None);

                if (status.IsCompleted && !string.IsNullOrWhiteSpace(status.VideoUrl))
                {
                    // 下载到 COS
                    var dl = await client.DownloadVideoBytesAsync(appCallerCode, submitResult.JobId!, 0, CancellationToken.None);
                    if (!dl.Success || dl.Bytes == null)
                    {
                        await MarkSceneErrorAsync(run.Id, sceneIdx, "下载视频失败: " + dl.ErrorMessage);
                        return;
                    }
                    RegistryAssetStorage.OverrideNextScope("generated");
                    var stored = await _assetStorage.SaveAsync(dl.Bytes, dl.ContentType ?? "video/mp4",
                        CancellationToken.None,
                        domain: AppDomainPaths.DomainVideoAgent, type: AppDomainPaths.TypeVideo);

                    var version = new VideoGenSceneVersion
                    {
                        VideoUrl = stored.Url,
                        JobId = submitResult.JobId,
                        Model = submitResult.ActualModel ?? scene.Model ?? run.DirectVideoModel,
                        Prompt = scene.Prompt,
                        Duration = scene.Duration ?? run.DirectDuration,
                        FirstFrameUrl = scene.FirstFrameUrl,
                        LastFrameUrl = scene.LastFrameUrl,
                        Cost = status.Cost,
                    };

                    await _db.VideoGenRuns.UpdateOneAsync(
                        x => x.Id == run.Id,
                        Builders<VideoGenRun>.Update
                            .Set($"Scenes.{sceneIdx}.Status", SceneItemStatus.Done)
                            .Set($"Scenes.{sceneIdx}.VideoUrl", stored.Url)
                            .Set($"Scenes.{sceneIdx}.ActiveVersionId", version.Id)
                            .Set($"Scenes.{sceneIdx}.JobId", submitResult.JobId)
                            .Set($"Scenes.{sceneIdx}.Model", version.Model)
                            .Set($"Scenes.{sceneIdx}.Cost", status.Cost)
                            .Push($"Scenes.{sceneIdx}.Versions", version),
                        cancellationToken: CancellationToken.None);

                    await PublishEventAsync(run.Id, "scene.render.done",
                        new { sceneIndex = sceneIdx, videoUrl = stored.Url, cost = status.Cost });

                    _logger.LogInformation("VideoGen 单镜完成: runId={RunId}, scene={Idx}, url={Url}",
                        run.Id, sceneIdx, stored.Url);
                    return;
                }

                if (status.IsFailed)
                {
                    await MarkSceneErrorAsync(run.Id, sceneIdx,
                        status.ErrorMessage ?? $"OpenRouter 状态 = {status.Status}");
                    return;
                }
            }

            await MarkSceneErrorAsync(run.Id, sceneIdx, $"单镜生成超过 {maxWaitMinutes} 分钟未完成");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "VideoGen 单镜渲染异常: runId={RunId}, scene={Idx}", run.Id, sceneIdx);
            await MarkSceneErrorAsync(run.Id, sceneIdx, ex.Message);
        }
    }

    /// <summary>处理单镜重生成 prompt（用户点"重新设计这个分镜"）</summary>
    private async Task ProcessSceneRegenerateAsync(VideoGenRun run)
    {
        var sceneIdx = run.Scenes.FindIndex(s => s.Status == SceneItemStatus.Generating);
        if (sceneIdx < 0) return;
        var scene = run.Scenes[sceneIdx];

        using var scope = _scopeFactory.CreateScope();
        var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();
        var ctxAccessor = scope.ServiceProvider.GetRequiredService<ILLMRequestContextAccessor>();

        using var _ = ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null, SessionId: null,
            UserId: run.OwnerAdminId,
            ViewRole: null, DocumentChars: null, DocumentHash: null, SystemPromptRedacted: null,
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.VideoAgent.Script.Chat,
            ForceFullShadowSample: run.ForceFullShadowSample));

        var systemPrompt = "你是视频导演。请重新生成一个英文 prompt 来描述同一主题的新镜头，画面要与原 prompt 不同但风格一致。直接输出 prompt 文本，不要解释、不要 JSON。";
        var userMsg = $"原主题：{scene.Topic}\n原 prompt：{scene.Prompt}\n\n请生成一个新 prompt。";
        if (!string.IsNullOrWhiteSpace(run.StyleDescription))
            userMsg = $"统一风格：{run.StyleDescription}\n\n" + userMsg;

        var resolution = await gateway.ResolveModelAsync(
            AppCallerRegistry.VideoAgent.Script.Chat, ModelTypes.Chat, null, ct: CancellationToken.None);
        if (!resolution.Success)
        {
            await MarkSceneErrorAsync(run.Id, sceneIdx, "模型调度失败: " + resolution.ErrorMessage);
            return;
        }

        var resp = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.Script.Chat,
            ModelType = ModelTypes.Chat,
            RequestBody = new System.Text.Json.Nodes.JsonObject
            {
                ["messages"] = new System.Text.Json.Nodes.JsonArray
                {
                    new System.Text.Json.Nodes.JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = userMsg },
                },
                ["temperature"] = 0.9,
            },
            TimeoutSeconds = 60,
        }, resolution, CancellationToken.None);

        if (!resp.Success)
        {
            await MarkSceneErrorAsync(run.Id, sceneIdx, "重生成 LLM 调用失败");
            return;
        }

        var newPrompt = ExtractAssistantText(resp.Content ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(newPrompt))
        {
            await MarkSceneErrorAsync(run.Id, sceneIdx, "LLM 返回为空");
            return;
        }

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set($"Scenes.{sceneIdx}.Status", SceneItemStatus.Draft)
                .Set($"Scenes.{sceneIdx}.Prompt", newPrompt)
                .Set($"Scenes.{sceneIdx}.ErrorMessage", (string?)null),
            cancellationToken: CancellationToken.None);

        await PublishEventAsync(run.Id, "scene.prompt.regenerated", new { sceneIndex = sceneIdx, prompt = newPrompt });
    }

    private async Task MarkSceneErrorAsync(string runId, int sceneIdx, string errorMessage)
    {
        var trimmed = errorMessage.Length > 500 ? errorMessage[..500] + "…" : errorMessage;
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update
                .Set($"Scenes.{sceneIdx}.Status", SceneItemStatus.Error)
                .Set($"Scenes.{sceneIdx}.ErrorMessage", trimmed),
            cancellationToken: CancellationToken.None);
        await PublishEventAsync(runId, "scene.render.error",
            new { sceneIndex = sceneIdx, message = trimmed });
    }

    private async Task<VideoGenRun?> ClaimExportRunAsync(CancellationToken ct)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.Eq(x => x.Status, VideoGenRunStatus.Rendering)
                     & fb.Eq(x => x.ExportRequested, true);
        var update = Builders<VideoGenRun>.Update
            .Set(x => x.ExportRequested, false)
            .Set(x => x.ExportStartedAt, DateTime.UtcNow)
            .Set(x => x.CurrentPhase, "export-preparing")
            .Set(x => x.PhaseProgress, 5);
        return await _db.VideoGenRuns.FindOneAndUpdateAsync(
            filter,
            update,
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
    }

    private async Task<VideoExportTask?> ClaimExportTaskAsync(CancellationToken ct)
    {
        var filter = Builders<VideoExportTask>.Filter.Eq(x => x.Status, VideoExportTaskStatus.Queued);
        return await _db.VideoExportTasks.FindOneAndUpdateAsync(
            filter,
            Builders<VideoExportTask>.Update
                .Set(x => x.Status, VideoExportTaskStatus.Processing)
                .Set(x => x.CurrentPhase, "export-preparing")
                .Set(x => x.Progress, 5)
                .Set(x => x.StartedAt, DateTime.UtcNow),
            new FindOneAndUpdateOptions<VideoExportTask> { ReturnDocument = ReturnDocument.After },
            ct);
    }

    private async Task ProcessExportAsync(VideoGenRun run, VideoExportTask? exportTask = null)
    {
        if (run.CancelRequested)
        {
            await CancelRunAsync(run);
            if (exportTask != null)
            {
                await _db.VideoExportTasks.UpdateOneAsync(
                    x => x.Id == exportTask.Id,
                    Builders<VideoExportTask>.Update
                        .Set(x => x.Status, VideoExportTaskStatus.Cancelled)
                        .Set(x => x.CurrentPhase, "cancelled")
                        .Set(x => x.EndedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
            }
            return;
        }
        var project = string.IsNullOrWhiteSpace(run.ProjectId)
            ? null
            : await _db.VideoProjects.Find(x => x.Id == run.ProjectId).FirstOrDefaultAsync(CancellationToken.None);
        var videoTrack = project?.TimelineTracks.FirstOrDefault(track => track.Type == VideoTrackType.Video);
        if (videoTrack?.Muted == true)
        {
            await FailExportAsync(run, "视频轨已静音，无法导出可播放视频", exportTask?.Id);
            return;
        }
        var timelineClips = videoTrack?.Clips
            .Where(clip => clip.SceneIndex.HasValue && clip.SceneIndex.Value >= 0 && clip.SceneIndex.Value < run.Scenes.Count)
            .ToList() ?? [];
        if (timelineClips.Count == 0)
        {
            timelineClips = run.Scenes.Select((scene, index) => new VideoTimelineClip
            {
                SceneIndex = index,
                StartSeconds = run.Scenes.Take(index).Sum(item => item.Duration ?? run.DirectDuration ?? 5),
                DurationSeconds = scene.Duration ?? run.DirectDuration ?? 5,
            }).ToList();
        }
        var selectedScenes = timelineClips.Select(clip => (Clip: clip, Scene: run.Scenes[clip.SceneIndex!.Value])).ToList();
        if (selectedScenes.Count == 0 || selectedScenes.Any(item => string.IsNullOrWhiteSpace(item.Scene.VideoUrl)))
        {
            await FailExportAsync(run, "存在尚未生成的视频分镜", exportTask?.Id);
            return;
        }

        var tempDir = Path.Combine(Path.GetTempPath(), $"prd-video-export-{run.Id}");
        Directory.CreateDirectory(tempDir);
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var httpClientFactory = scope.ServiceProvider.GetRequiredService<IHttpClientFactory>();
            var httpClient = httpClientFactory.CreateClient();
            using var externalHttpClient = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
            {
                Timeout = TimeSpan.FromMinutes(3),
            };
            var videoInputs = new List<VideoExportClipSource>();

            for (var index = 0; index < selectedScenes.Count; index++)
            {
                var inputFile = Path.Combine(tempDir, $"scene-{index:D3}.mp4");
                await DownloadToFileAsync(httpClient, selectedScenes[index].Scene.VideoUrl!, inputFile, 1024L * 1024 * 1024);
                var probe = await ProbeMediaAsync(inputFile);
                var timelineClip = selectedScenes[index].Clip;
                videoInputs.Add(new VideoExportClipSource(
                    inputFile,
                    probe.DurationSeconds > 0 ? probe.DurationSeconds : timelineClip.DurationSeconds,
                    probe.HasAudio,
                    timelineClip.TrimStartSeconds,
                    timelineClip.TrimEndSeconds,
                    timelineClip.Transition));

                var progress = 10 + (int)Math.Round((index + 1d) / selectedScenes.Count * 25d);
                await UpdateExportProgressAsync(run.Id, exportTask?.Id, "export-downloading", progress);
            }

            var audioInputs = new List<VideoExportAudioSource>();
            var audioTimelineClips = project?.TimelineTracks
                .Where(track => !track.Muted && track.Type is VideoTrackType.Voice or VideoTrackType.Music)
                .SelectMany(track => track.Clips.Select(clip => (TrackType: track.Type, Clip: clip)))
                .Where(item => !string.IsNullOrWhiteSpace(item.Clip.AssetUrl))
                .ToList() ?? [];
            for (var index = 0; index < audioTimelineClips.Count; index++)
            {
                var item = audioTimelineClips[index];
                await EnsurePublicHttpsUrlAsync(item.Clip.AssetUrl!);
                var inputFile = Path.Combine(tempDir, $"audio-{index:D3}.bin");
                await DownloadToFileAsync(externalHttpClient, item.Clip.AssetUrl!, inputFile, 100L * 1024 * 1024);
                var probe = await ProbeMediaAsync(inputFile);
                if (!probe.HasAudio) throw new InvalidOperationException($"音频轨素材 {index + 1} 不包含可识别音轨");
                audioInputs.Add(new VideoExportAudioSource(
                    inputFile,
                    item.Clip.StartSeconds,
                    item.Clip.DurationSeconds > 0 ? item.Clip.DurationSeconds : probe.DurationSeconds,
                    item.Clip.TrimStartSeconds,
                    item.Clip.TrimEndSeconds,
                    item.TrackType == VideoTrackType.Music ? 0.35 : 1));
            }

            var subtitleFile = await WriteSubtitleFileAsync(project, tempDir);
            var outputFile = Path.Combine(tempDir, "export.mp4");
            var args = VideoExportCommandBuilder.Build(
                videoInputs,
                audioInputs,
                subtitleFile,
                outputFile,
                run.DirectAspectRatio);
            var startInfo = new ProcessStartInfo
            {
                FileName = "ffmpeg",
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var arg in args) startInfo.ArgumentList.Add(arg);

            await UpdateExportProgressAsync(run.Id, exportTask?.Id, "export-composing", 50);
            using var process = Process.Start(startInfo)
                                ?? throw new InvalidOperationException("ffmpeg 进程启动失败");
            var stderrTask = process.StandardError.ReadToEndAsync();
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var exitTask = process.WaitForExitAsync(CancellationToken.None);
            var completed = await Task.WhenAny(exitTask, Task.Delay(TimeSpan.FromMinutes(15), CancellationToken.None));
            if (completed != exitTask)
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                throw new TimeoutException("视频合成超过 15 分钟");
            }
            await exitTask;
            var stderr = await stderrTask;
            _ = await stdoutTask;
            if (process.ExitCode != 0 || !File.Exists(outputFile))
            {
                var detail = stderr.Length > 1200 ? stderr[^1200..] : stderr;
                throw new InvalidOperationException($"ffmpeg 合成失败 (exit={process.ExitCode}): {detail}");
            }

            await UpdateExportProgressAsync(run.Id, exportTask?.Id, "export-uploading", 90);
            var bytes = await File.ReadAllBytesAsync(outputFile, CancellationToken.None);
            RegistryAssetStorage.OverrideNextScope("generated");
            var stored = await _assetStorage.SaveAsync(
                bytes,
                "video/mp4",
                CancellationToken.None,
                domain: AppDomainPaths.DomainVideoAgent,
                type: AppDomainPaths.TypeVideo);

            var totalCost = run.Scenes.Where(scene => scene.Cost.HasValue).Sum(scene => scene.Cost!.Value);
            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update
                    .Set(x => x.Status, VideoGenRunStatus.Completed)
                    .Set(x => x.VideoAssetUrl, stored.Url)
                    .Set(x => x.DirectVideoCost, totalCost)
                    .Set(x => x.ExportErrorMessage, (string?)null)
                    .Set(x => x.ExportedAt, DateTime.UtcNow)
                    .Set(x => x.EndedAt, DateTime.UtcNow)
                    .Set(x => x.CurrentPhase, "completed")
                    .Set(x => x.PhaseProgress, 100),
                cancellationToken: CancellationToken.None);
            if (exportTask != null)
            {
                await _db.VideoExportTasks.UpdateOneAsync(
                    x => x.Id == exportTask.Id,
                    Builders<VideoExportTask>.Update
                        .Set(x => x.Status, VideoExportTaskStatus.Completed)
                        .Set(x => x.CurrentPhase, "completed")
                        .Set(x => x.Progress, 100)
                        .Set(x => x.OutputUrl, stored.Url)
                        .Set(x => x.ErrorMessage, (string?)null)
                        .Set(x => x.EndedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
            }
            await UpdateProjectAsync(run, VideoProjectStatus.Completed);
            await PublishEventAsync(run.Id, "export.completed", new { videoUrl = stored.Url, cost = totalCost });
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); }
            catch (Exception ex) { _logger.LogWarning(ex, "VideoGen 导出临时目录清理失败: {Path}", tempDir); }
        }
    }

    private static async Task DownloadToFileAsync(HttpClient client, string url, string targetPath, long maxBytes)
    {
        using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, CancellationToken.None);
        response.EnsureSuccessStatusCode();
        var contentLength = response.Content.Headers.ContentLength;
        if (contentLength.HasValue && contentLength.Value > maxBytes)
            throw new InvalidOperationException($"媒体文件超过大小限制：{contentLength.Value} bytes");
        await using var source = await response.Content.ReadAsStreamAsync(CancellationToken.None);
        await using var target = File.Create(targetPath);
        var buffer = new byte[81920];
        long total = 0;
        while (true)
        {
            var read = await source.ReadAsync(buffer, CancellationToken.None);
            if (read == 0) break;
            total += read;
            if (total > maxBytes) throw new InvalidOperationException("媒体文件超过大小限制");
            await target.WriteAsync(buffer.AsMemory(0, read), CancellationToken.None);
        }
    }

    private static async Task<MediaProbeResult> ProbeMediaAsync(string filePath)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "ffprobe",
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
                 {
                     "-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_type",
                     "-of", "json", filePath,
                 })
            startInfo.ArgumentList.Add(arg);
        using var process = Process.Start(startInfo)
                            ?? throw new InvalidOperationException("ffprobe 进程启动失败");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync(CancellationToken.None);
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"ffprobe 读取媒体失败: {stderr}");
        var json = JsonNode.Parse(stdout) as JsonObject
                   ?? throw new InvalidOperationException("ffprobe 返回了无效 JSON");
        var durationText = json["format"]?["duration"]?.ToString().Trim('"');
        _ = double.TryParse(durationText, NumberStyles.Float, CultureInfo.InvariantCulture, out var duration);
        var hasAudio = json["streams"] is JsonArray streams && streams
            .OfType<JsonObject>()
            .Any(stream => string.Equals(stream["codec_type"]?.ToString(), "audio", StringComparison.OrdinalIgnoreCase));
        return new MediaProbeResult(duration, hasAudio);
    }

    private static async Task<string?> WriteSubtitleFileAsync(VideoProject? project, string tempDir)
    {
        var track = project?.TimelineTracks.FirstOrDefault(item =>
            item.Type == VideoTrackType.Subtitle && !item.Muted);
        var clips = track?.Clips
            .Where(clip => !string.IsNullOrWhiteSpace(clip.Text) && clip.DurationSeconds > 0)
            .OrderBy(clip => clip.StartSeconds)
            .ToList();
        if (clips == null || clips.Count == 0) return null;
        var content = new StringBuilder();
        for (var index = 0; index < clips.Count; index++)
        {
            var clip = clips[index];
            content.AppendLine((index + 1).ToString(CultureInfo.InvariantCulture));
            content.Append(FormatSrtTime(clip.StartSeconds));
            content.Append(" --> ");
            content.AppendLine(FormatSrtTime(clip.StartSeconds + clip.DurationSeconds));
            content.AppendLine(clip.Text!.Trim().Replace("\r\n", "\n").Replace('\r', '\n'));
            content.AppendLine();
        }
        var path = Path.Combine(tempDir, "subtitles.srt");
        await File.WriteAllTextAsync(path, content.ToString(), new UTF8Encoding(false), CancellationToken.None);
        return path;
    }

    private static string FormatSrtTime(double seconds)
    {
        var value = TimeSpan.FromSeconds(Math.Max(0, seconds));
        return $"{(int)value.TotalHours:00}:{value.Minutes:00}:{value.Seconds:00},{value.Milliseconds:000}";
    }

    private static async Task EnsurePublicHttpsUrlAsync(string rawUrl)
    {
        if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("音频素材必须使用公开 HTTPS URL");
        IPAddress[] addresses;
        try { addresses = await Dns.GetHostAddressesAsync(uri.DnsSafeHost); }
        catch (Exception ex) { throw new InvalidOperationException("音频素材域名无法解析", ex); }
        if (addresses.Length == 0 || addresses.Any(IsPrivateAddress))
            throw new InvalidOperationException("音频素材 URL 不允许指向本机或内网地址");
    }

    private static bool IsPrivateAddress(IPAddress address)
    {
        if (IPAddress.IsLoopback(address) || address.IsIPv6LinkLocal || address.IsIPv6SiteLocal)
            return true;
        if (address.AddressFamily == AddressFamily.InterNetworkV6 && address.IsIPv4MappedToIPv6)
            address = address.MapToIPv4();
        if (address.AddressFamily != AddressFamily.InterNetwork) return false;
        var bytes = address.GetAddressBytes();
        return bytes[0] is 0 or 10 or 127 ||
               (bytes[0] == 100 && bytes[1] is >= 64 and <= 127) ||
               (bytes[0] == 169 && bytes[1] == 254) ||
               (bytes[0] == 172 && bytes[1] is >= 16 and <= 31) ||
               (bytes[0] == 192 && bytes[1] == 168) ||
               bytes[0] >= 224;
    }

    private sealed record MediaProbeResult(double DurationSeconds, bool HasAudio);

    private async Task UpdateExportProgressAsync(string runId, string? exportTaskId, string phase, int progress)
    {
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update
                .Set(x => x.CurrentPhase, phase)
                .Set(x => x.PhaseProgress, progress),
            cancellationToken: CancellationToken.None);
        if (!string.IsNullOrWhiteSpace(exportTaskId))
        {
            await _db.VideoExportTasks.UpdateOneAsync(
                x => x.Id == exportTaskId,
                Builders<VideoExportTask>.Update
                    .Set(x => x.CurrentPhase, phase)
                    .Set(x => x.Progress, progress),
                cancellationToken: CancellationToken.None);
        }
        await PublishEventAsync(runId, "export.progress", new { taskId = exportTaskId, phase, progress });
    }

    private async Task FailExportAsync(VideoGenRun run, string errorMessage, string? exportTaskId = null)
    {
        var trimmed = errorMessage.Length > 1200 ? errorMessage[..1200] : errorMessage;
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Editing)
                .Set(x => x.ExportRequested, false)
                .Set(x => x.ExportErrorMessage, trimmed)
                .Set(x => x.CurrentPhase, "export-failed")
                .Set(x => x.PhaseProgress, 0),
            cancellationToken: CancellationToken.None);
        if (!string.IsNullOrWhiteSpace(exportTaskId))
        {
            await _db.VideoExportTasks.UpdateOneAsync(
                x => x.Id == exportTaskId,
                Builders<VideoExportTask>.Update
                    .Set(x => x.Status, VideoExportTaskStatus.Failed)
                    .Set(x => x.CurrentPhase, "export-failed")
                    .Set(x => x.Progress, 0)
                    .Set(x => x.ErrorMessage, trimmed)
                    .Set(x => x.EndedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
        }
        await UpdateProjectAsync(run, VideoProjectStatus.Editing);
        await PublishEventAsync(run.Id, "export.error", new { message = trimmed });
    }

    private async Task UpdatePhaseAsync(VideoGenRun run, string phase, int progress)
    {
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.CurrentPhase, phase)
                .Set(x => x.PhaseProgress, progress),
            cancellationToken: CancellationToken.None);
    }

    private async Task UpdateProjectAsync(VideoGenRun run, string status)
    {
        if (string.IsNullOrWhiteSpace(run.ProjectId)) return;
        await _db.VideoProjects.UpdateOneAsync(
            x => x.Id == run.ProjectId,
            Builders<VideoProject>.Update
                .Set(x => x.Status, status)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
    }

    private async Task SyncProjectStoryboardAsync(
        VideoGenRun run,
        IReadOnlyList<VideoGenScene> scenes,
        string? aiTitle)
    {
        if (string.IsNullOrWhiteSpace(run.ProjectId)) return;
        var project = await _db.VideoProjects.Find(x => x.Id == run.ProjectId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (project == null) return;

        var clips = new List<VideoTimelineClip>();
        double cursor = 0;
        for (var index = 0; index < scenes.Count; index++)
        {
            var duration = scenes[index].Duration ?? run.DirectDuration ?? 5;
            clips.Add(new VideoTimelineClip
            {
                SceneIndex = index,
                StartSeconds = cursor,
                DurationSeconds = duration,
            });
            cursor += duration;
        }

        var tracks = project.TimelineTracks.Count > 0
            ? project.TimelineTracks
            : new List<VideoTimelineTrack>();
        var videoTrack = tracks.FirstOrDefault(track => track.Type == VideoTrackType.Video);
        if (videoTrack == null)
        {
            videoTrack = new VideoTimelineTrack { Type = VideoTrackType.Video, Name = "视频" };
            tracks.Insert(0, videoTrack);
        }
        videoTrack.Clips = clips;

        var update = Builders<VideoProject>.Update
            .Set(x => x.Status, VideoProjectStatus.Editing)
            .Set(x => x.TimelineTracks, tracks)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (!string.IsNullOrWhiteSpace(aiTitle))
        {
            var title = aiTitle.Trim();
            update = update.Set(x => x.Title, title[..Math.Min(title.Length, 60)]);
        }
        await _db.VideoProjects.UpdateOneAsync(x => x.Id == run.ProjectId,
            update, cancellationToken: CancellationToken.None);
    }

    private async Task<VideoProject?> GetRunProjectAsync(VideoGenRun run)
    {
        if (string.IsNullOrWhiteSpace(run.ProjectId)) return null;
        return await _db.VideoProjects.Find(project => project.Id == run.ProjectId)
            .FirstOrDefaultAsync(CancellationToken.None);
    }

    private async Task<bool> SupportsReferenceAssetsAsync(string? model)
    {
        if (string.IsNullOrWhiteSpace(model)) return false;
        if (model.Contains("seedance-2", StringComparison.OrdinalIgnoreCase)) return true;
        var config = await _db.LLMModels.Find(item => item.Id == model || item.ModelName == model)
            .FirstOrDefaultAsync(CancellationToken.None);
        return config?.ModelName.Contains("seedance-2", StringComparison.OrdinalIgnoreCase) == true;
    }

    private static List<string> GetReferenceImageUrls(VideoProject? project)
        => project?.Assets
            .Where(asset => asset.Type is VideoProjectAssetType.Character or VideoProjectAssetType.Scene or VideoProjectAssetType.Prop)
            .Select(asset => asset.Url)
            .Where(url => !string.IsNullOrWhiteSpace(url))
            .Select(url => url!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(9)
            .ToList() ?? [];

    private static string AppendAssetConstraints(string prompt, VideoProject? project)
    {
        var assets = project?.Assets
            .Where(asset => asset.Type is VideoProjectAssetType.Character or VideoProjectAssetType.Scene or VideoProjectAssetType.Prop)
            .Take(20)
            .ToList();
        if (assets == null || assets.Count == 0) return prompt;
        var manifest = string.Join("\n", assets.Select(asset =>
            $"- {asset.Type}: {asset.Name}" +
            (string.IsNullOrWhiteSpace(asset.Description) ? string.Empty : $"；{asset.Description}")));
        return $"{prompt}\n\n项目一致性约束：以下角色、场景和道具在所有镜头中必须保持外观、服装、色彩和比例一致。\n{manifest}";
    }
}
