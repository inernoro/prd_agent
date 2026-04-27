using System.Text.Json.Nodes;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 视频生成后台执行器（纯 OpenRouter 直出模式）
///
/// 架构：用户提交 prompt → Worker 调 OpenRouter Veo/Kling/Wan/Sora → 拿到视频 URL →
/// 用 API Key 鉴权下载视频二进制 → 上传到 COS → 把 COS 公开 URL 写回 Run.VideoAssetUrl
///
/// 历史：原本支持 Remotion 拆分镜路径（文章→脚本→分镜→Remotion 渲染→拼接），但 docker dev 模式下
/// Remotion + Chromium 部署反复踩坑，2026-04-27 决定彻底砍掉，只保留 OpenRouter 直出。
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
        const string appCallerCode = AppCallerRegistry.VideoAgent.VideoGen.Generate;

        _logger.LogInformation("VideoGen 直出开始: runId={RunId}, userModel={Model}, duration={Duration}s",
            run.Id, run.DirectVideoModel, run.DirectDuration);

        await PublishEventAsync(run.Id, "phase.changed", new { phase = "videogen-submitting", progress = 5 });

        using var scope = _scopeFactory.CreateScope();
        var client = scope.ServiceProvider.GetRequiredService<IOpenRouterVideoClient>();

        // ─── 提交任务 ───
        var prompt = run.DirectPrompt ?? string.Empty;
        if (string.IsNullOrWhiteSpace(prompt))
        {
            await FailRunAsync(run, "EMPTY_PROMPT", "directPrompt 为空，无法生成视频");
            return;
        }

        var submitReq = new OpenRouterVideoSubmitRequest
        {
            AppCallerCode = appCallerCode,
            Model = run.DirectVideoModel, // 用户偏好（可空）；由模型池决定最终选择
            Prompt = prompt,
            AspectRatio = run.DirectAspectRatio,
            Resolution = run.DirectResolution,
            DurationSeconds = run.DirectDuration,
            GenerateAudio = true,
            UserId = run.OwnerAdminId,
            RequestId = run.Id
        };

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
        @"你是视频导演。请把用户提供的文章/PRD 拆解为 3-8 个适合短视频生成的分镜。
每个分镜应该是 5-10 秒的画面，能用一句话英文 prompt 喂给视频大模型（Veo / Kling / Wan / Sora）生成。

输出 JSON 数组，每个元素 schema:
{
  ""topic"": ""中文小标题，6 字内"",
  ""prompt"": ""英文视频生成 prompt，描述画面内容、镜头语言、风格、光影"",
  ""duration"": 5
}

要求：
- 整段视频不超过 60 秒（所有 duration 之和）
- 每段 prompt 独立可读，不依赖前后文
- 风格保持一致（用户可能在 styleDescription 里指定，要融入每段 prompt）
- 不要写解释、不要包 markdown 代码块，直接输出 JSON 数组

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
            AppCallerCode: AppCallerRegistry.VideoAgent.Script.Chat
        ));

        var userPrompt = string.IsNullOrWhiteSpace(run.StyleDescription)
            ? run.ArticleMarkdown
            : $"风格要求：{run.StyleDescription}\n\n文章内容：\n{run.ArticleMarkdown}";

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
            AppCallerRegistry.VideoAgent.Script.Chat, ModelTypes.Chat, null, CancellationToken.None);
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
        var scenes = ParseScenesFromLlmResponse(llmText, run);
        if (scenes.Count == 0)
        {
            await FailRunAsync(run, "PARSE_FAILED", "LLM 返回无法解析为分镜数组");
            return;
        }

        var totalDuration = scenes.Sum(s => s.Duration ?? run.DirectDuration ?? 5);

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Scenes, scenes)
                .Set(x => x.TotalDurationSeconds, totalDuration)
                .Set(x => x.Status, VideoGenRunStatus.Editing)
                .Set(x => x.CurrentPhase, "editing")
                .Set(x => x.PhaseProgress, 100),
            cancellationToken: CancellationToken.None);

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

    private static List<VideoGenScene> ParseScenesFromLlmResponse(string text, VideoGenRun run)
    {
        // 提取 JSON 数组（兼容 ``` 包裹）
        var trimmed = text.Trim();
        var startIdx = trimmed.IndexOf('[');
        var endIdx = trimmed.LastIndexOf(']');
        if (startIdx < 0 || endIdx <= startIdx) return new List<VideoGenScene>();

        var jsonText = trimmed[startIdx..(endIdx + 1)];

        try
        {
            var arr = System.Text.Json.Nodes.JsonNode.Parse(jsonText)?.AsArray();
            if (arr == null) return new List<VideoGenScene>();

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
        catch
        {
            return new List<VideoGenScene>();
        }
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

        const string appCallerCode = AppCallerRegistry.VideoAgent.VideoGen.Generate;
        _logger.LogInformation("VideoGen 单镜渲染开始: runId={RunId}, scene={Idx}, prompt={Len}字",
            run.Id, sceneIdx, scene.Prompt.Length);
        await PublishEventAsync(run.Id, "scene.render.start", new { sceneIndex = sceneIdx });

        using var scope = _scopeFactory.CreateScope();
        var client = scope.ServiceProvider.GetRequiredService<IOpenRouterVideoClient>();

        try
        {
            var submitReq = new OpenRouterVideoSubmitRequest
            {
                AppCallerCode = appCallerCode,
                Model = scene.Model ?? run.DirectVideoModel,
                Prompt = scene.Prompt,
                AspectRatio = scene.AspectRatio ?? run.DirectAspectRatio,
                Resolution = scene.Resolution ?? run.DirectResolution,
                DurationSeconds = scene.Duration ?? run.DirectDuration,
                GenerateAudio = false, // 单镜不出音频，最终 concat 时再统一处理
                UserId = run.OwnerAdminId,
                RequestId = $"{run.Id}_scene_{sceneIdx}",
            };

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

                    await _db.VideoGenRuns.UpdateOneAsync(
                        x => x.Id == run.Id,
                        Builders<VideoGenRun>.Update
                            .Set($"Scenes.{sceneIdx}.Status", SceneItemStatus.Done)
                            .Set($"Scenes.{sceneIdx}.VideoUrl", stored.Url)
                            .Set($"Scenes.{sceneIdx}.Cost", status.Cost),
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
            AppCallerCode: AppCallerRegistry.VideoAgent.Script.Chat));

        var systemPrompt = "你是视频导演。请重新生成一个英文 prompt 来描述同一主题的新镜头，画面要与原 prompt 不同但风格一致。直接输出 prompt 文本，不要解释、不要 JSON。";
        var userMsg = $"原主题：{scene.Topic}\n原 prompt：{scene.Prompt}\n\n请生成一个新 prompt。";
        if (!string.IsNullOrWhiteSpace(run.StyleDescription))
            userMsg = $"统一风格：{run.StyleDescription}\n\n" + userMsg;

        var resolution = await gateway.ResolveModelAsync(
            AppCallerRegistry.VideoAgent.Script.Chat, ModelTypes.Chat, null, CancellationToken.None);
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

    private async Task UpdatePhaseAsync(VideoGenRun run, string phase, int progress)
    {
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.CurrentPhase, phase)
                .Set(x => x.PhaseProgress, progress),
            cancellationToken: CancellationToken.None);
    }
}
