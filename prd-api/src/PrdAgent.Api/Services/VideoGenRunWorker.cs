using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 视频生成后台执行器（交互式流程）
/// 两条处理路径：
///   1. Queued → Scripting → Editing（分镜生成完成，等待用户编辑）
///   2. Rendering → Completed（用户点击"导出"后触发渲染）
/// 同时轮询 Editing 状态中 Generating 的分镜，进行单条重试。
/// 遵循服务器权威性设计：核心处理使用 CancellationToken.None
/// </summary>
public class VideoGenRunWorker : BackgroundService
{
    private readonly MongoDbContext _db;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IRunEventStore _runStore;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<VideoGenRunWorker> _logger;
    private readonly IConfiguration _configuration;

    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    /// <summary>推荐语速：3.7 字/秒</summary>
    private const double CharsPerSecond = 3.7;

    public VideoGenRunWorker(
        MongoDbContext db,
        IServiceScopeFactory scopeFactory,
        IRunEventStore runStore,
        IAssetStorage assetStorage,
        ILogger<VideoGenRunWorker> logger,
        IConfiguration configuration)
    {
        _db = db;
        _scopeFactory = scopeFactory;
        _runStore = runStore;
        _assetStorage = assetStorage;
        _logger = logger;
        _configuration = configuration;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // 路径 0 (新增): videogen 模式 Queued → 直接走 OpenRouter，不经分镜流程
                var directRun = await ClaimQueuedDirectVideoGenRunAsync(stoppingToken);
                if (directRun != null)
                {
                    try
                    {
                        await ProcessDirectVideoGenAsync(directRun);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGenRunWorker 直出视频失败: runId={RunId}", directRun.Id);
                        await FailRunAsync(directRun, "VIDEOGEN_ERROR", ex.Message);
                    }
                    continue;
                }

                // 路径 1: Queued → Scripting → Editing
                var queued = await ClaimQueuedRunAsync(stoppingToken);
                if (queued != null)
                {
                    try
                    {
                        await ProcessScriptingAsync(queued);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGenRunWorker 分镜生成失败: runId={RunId}", queued.Id);
                        await FailRunAsync(queued, "SCRIPTING_ERROR", ex.Message);
                    }
                    continue;
                }

                // 路径 2: Rendering → Completed
                var rendering = await ClaimRenderingRunAsync(stoppingToken);
                if (rendering != null)
                {
                    try
                    {
                        await ProcessRenderingAsync(rendering);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGenRunWorker 渲染失败: runId={RunId}", rendering.Id);
                        await FailRunAsync(rendering, "RENDER_ERROR", ex.Message);
                    }
                    continue;
                }

                // 路径 3: Editing 状态中有 Generating 分镜 → 单条重试
                var edited = await FindEditingRunWithGeneratingSceneAsync(stoppingToken);
                if (edited != null)
                {
                    try
                    {
                        await ProcessSceneRegenerationAsync(edited);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGenRunWorker 分镜重试失败: runId={RunId}", edited.Id);
                    }
                    continue;
                }

                // 路径 4: Editing 状态中有 imageStatus=running 的分镜 → Remotion 渲染单场景预览视频
                var previewPending = await FindEditingRunWithPendingPreviewAsync(stoppingToken);
                if (previewPending != null)
                {
                    try
                    {
                        await ProcessScenePreviewRenderAsync(previewPending);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGenRunWorker 分镜预览渲染失败: runId={RunId}", previewPending.Id);
                        // 兜底：将所有仍处于 running 的分镜标记为 error，避免前端永远卡在"渲染中"
                        try
                        {
                            var updates = new List<UpdateDefinition<VideoGenRun>>();
                            for (int i = 0; i < previewPending.Scenes.Count; i++)
                            {
                                if (previewPending.Scenes[i].ImageStatus == "running")
                                {
                                    updates.Add(Builders<VideoGenRun>.Update
                                        .Set($"Scenes.{i}.ImageStatus", "error")
                                        .Set($"Scenes.{i}.ImageUrl", (string?)null));
                                }
                            }
                            if (updates.Count > 0)
                            {
                                await _db.VideoGenRuns.UpdateOneAsync(
                                    x => x.Id == previewPending.Id,
                                    Builders<VideoGenRun>.Update.Combine(updates),
                                    cancellationToken: CancellationToken.None);
                            }
                        }
                        catch (Exception innerEx)
                        {
                            _logger.LogError(innerEx, "VideoGenRunWorker 标记分镜失败状态异常: runId={RunId}", previewPending.Id);
                        }
                    }
                    continue;
                }

                // 路径 5: Editing 状态中有 backgroundImageStatus=running 的分镜 → 调图生模型生成背景图
                var bgPending = await FindEditingRunWithPendingBgImageAsync(stoppingToken);
                if (bgPending != null)
                {
                    try
                    {
                        await ProcessSceneBgImageGenerationAsync(bgPending);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGenRunWorker 背景图生成失败: runId={RunId}", bgPending.Id);
                        try
                        {
                            var updates = new List<UpdateDefinition<VideoGenRun>>();
                            for (int i = 0; i < bgPending.Scenes.Count; i++)
                            {
                                if (bgPending.Scenes[i].BackgroundImageStatus == "running")
                                {
                                    updates.Add(Builders<VideoGenRun>.Update
                                        .Set($"Scenes.{i}.BackgroundImageStatus", "error")
                                        .Set($"Scenes.{i}.BackgroundImageUrl", (string?)null));
                                }
                            }
                            if (updates.Count > 0)
                            {
                                await _db.VideoGenRuns.UpdateOneAsync(
                                    x => x.Id == bgPending.Id,
                                    Builders<VideoGenRun>.Update.Combine(updates),
                                    cancellationToken: CancellationToken.None);
                            }
                        }
                        catch (Exception innerEx)
                        {
                            _logger.LogError(innerEx, "VideoGenRunWorker 标记背景图失败状态异常: runId={RunId}", bgPending.Id);
                        }
                    }
                    continue;
                }

                // 路径 6: Editing 状态中有 audioStatus=running 的分镜 → TTS 音频生成
                var audioPending = await FindEditingRunWithPendingAudioAsync(stoppingToken);
                if (audioPending != null)
                {
                    try
                    {
                        await ProcessSceneAudioGenerationAsync(audioPending);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGenRunWorker TTS 音频生成失败: runId={RunId}", audioPending.Id);
                        try
                        {
                            var updates = new List<UpdateDefinition<VideoGenRun>>();
                            for (int i = 0; i < audioPending.Scenes.Count; i++)
                            {
                                if (audioPending.Scenes[i].AudioStatus == "running")
                                {
                                    updates.Add(Builders<VideoGenRun>.Update
                                        .Set($"Scenes.{i}.AudioStatus", "error")
                                        .Set($"Scenes.{i}.AudioErrorMessage", ex.Message));
                                }
                            }
                            if (updates.Count > 0)
                            {
                                await _db.VideoGenRuns.UpdateOneAsync(
                                    x => x.Id == audioPending.Id,
                                    Builders<VideoGenRun>.Update.Combine(updates),
                                    cancellationToken: CancellationToken.None);
                            }
                        }
                        catch (Exception innerEx)
                        {
                            _logger.LogError(innerEx, "VideoGenRunWorker 标记音频失败状态异常: runId={RunId}", audioPending.Id);
                        }
                    }
                    continue;
                }

                // 路径 7: Editing 状态中有 codeStatus=running 的分镜 → LLM 场景代码生成
                var codegenPending = await FindEditingRunWithPendingCodegenAsync(stoppingToken);
                if (codegenPending != null)
                {
                    try
                    {
                        await ProcessSceneCodegenAsync(codegenPending);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGenRunWorker 场景代码生成失败: runId={RunId}", codegenPending.Id);
                        try
                        {
                            var updates = new List<UpdateDefinition<VideoGenRun>>();
                            for (int i = 0; i < codegenPending.Scenes.Count; i++)
                            {
                                if (codegenPending.Scenes[i].CodeStatus == "running")
                                {
                                    updates.Add(Builders<VideoGenRun>.Update
                                        .Set($"Scenes.{i}.CodeStatus", "error")
                                        .Set($"Scenes.{i}.SceneCode", (string?)null));
                                }
                            }
                            if (updates.Count > 0)
                            {
                                await _db.VideoGenRuns.UpdateOneAsync(
                                    x => x.Id == codegenPending.Id,
                                    Builders<VideoGenRun>.Update.Combine(updates),
                                    cancellationToken: CancellationToken.None);
                            }
                        }
                        catch (Exception innerEx)
                        {
                            _logger.LogError(innerEx, "VideoGenRunWorker 标记代码生成失败状态异常: runId={RunId}", codegenPending.Id);
                        }
                    }
                    continue;
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }

            await Task.Delay(2000, stoppingToken);
        }
    }

    // ─── Claim Methods ───

    private async Task<VideoGenRun?> ClaimQueuedRunAsync(CancellationToken ct)
    {
        // 只拾取非 videogen 模式的 Queued 任务（remotion/空值/缺失字段）
        // 改为正向匹配：RenderMode 在 {null, "", "remotion"} 中，避免 $ne 的微妙陷阱
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.And(
            fb.Eq(x => x.Status, VideoGenRunStatus.Queued),
            fb.Or(
                fb.Eq(x => x.RenderMode, VideoRenderMode.Remotion),
                fb.Eq(x => x.RenderMode, string.Empty),
                fb.Eq(x => x.RenderMode, (string)null!)  // 兼容 old docs 没有此字段
            )
        );
        var update = Builders<VideoGenRun>.Update
            .Set(x => x.Status, VideoGenRunStatus.Scripting)
            .Set(x => x.StartedAt, DateTime.UtcNow)
            .Set(x => x.CurrentPhase, "scripting");

        var claimed = await _db.VideoGenRuns.FindOneAndUpdateAsync(filter, update,
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After }, ct);
        if (claimed != null)
        {
            _logger.LogInformation("[VideoGenWorker] Claimed Remotion run: runId={RunId}, renderMode={Mode}",
                claimed.Id, claimed.RenderMode ?? "(null)");
        }
        return claimed;
    }

    /// <summary>
    /// 拾取 videogen 模式的 Queued 任务，直接交给 OpenRouter 处理
    /// </summary>
    private async Task<VideoGenRun?> ClaimQueuedDirectVideoGenRunAsync(CancellationToken ct)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.And(
            fb.Eq(x => x.Status, VideoGenRunStatus.Queued),
            fb.Eq(x => x.RenderMode, VideoRenderMode.VideoGen)
        );
        var update = Builders<VideoGenRun>.Update
            .Set(x => x.Status, VideoGenRunStatus.Rendering)
            .Set(x => x.StartedAt, DateTime.UtcNow)
            .Set(x => x.CurrentPhase, "videogen-submitting")
            .Set(x => x.PhaseProgress, 1);

        var claimed = await _db.VideoGenRuns.FindOneAndUpdateAsync(filter, update,
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After }, ct);
        if (claimed != null)
        {
            _logger.LogInformation("[VideoGenWorker] Claimed VideoGen run: runId={RunId}, model={Model}",
                claimed.Id, claimed.DirectVideoModel);
        }
        return claimed;
    }

    private async Task<VideoGenRun?> ClaimRenderingRunAsync(CancellationToken ct)
    {
        // 只拾取 Rendering 状态 + PhaseProgress == 0（未开始的）+ 非 videogen 模式
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.And(
            fb.Eq(x => x.Status, VideoGenRunStatus.Rendering),
            fb.Eq(x => x.PhaseProgress, 0),
            fb.Or(
                fb.Exists(x => x.RenderMode, false),
                fb.Eq(x => x.RenderMode, VideoRenderMode.Remotion),
                fb.Eq(x => x.RenderMode, string.Empty)
            )
        );
        var update = Builders<VideoGenRun>.Update
            .Set(x => x.PhaseProgress, 1); // 标记为已领取

        return await _db.VideoGenRuns.FindOneAndUpdateAsync(filter, update,
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After }, ct);
    }

    private async Task<VideoGenRun?> FindEditingRunWithGeneratingSceneAsync(CancellationToken ct)
    {
        // 查找 Editing 状态中有 Generating 分镜的 Run
        var filter = Builders<VideoGenRun>.Filter.And(
            Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Editing),
            Builders<VideoGenRun>.Filter.ElemMatch(x => x.Scenes,
                Builders<VideoGenScene>.Filter.Eq(s => s.Status, SceneItemStatus.Generating)));

        // 轮询查询使用 CancellationToken.None，避免 stoppingToken 取消导致查询中断后触发兜底错误标记
        return await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(CancellationToken.None);
    }

    private async Task<VideoGenRun?> FindEditingRunWithPendingPreviewAsync(CancellationToken ct)
    {
        var filter = Builders<VideoGenRun>.Filter.And(
            Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Editing),
            Builders<VideoGenRun>.Filter.ElemMatch(x => x.Scenes,
                Builders<VideoGenScene>.Filter.Eq(s => s.ImageStatus, "running")));

        return await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(CancellationToken.None);
    }

    private async Task<VideoGenRun?> FindEditingRunWithPendingBgImageAsync(CancellationToken ct)
    {
        var filter = Builders<VideoGenRun>.Filter.And(
            Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Editing),
            Builders<VideoGenRun>.Filter.ElemMatch(x => x.Scenes,
                Builders<VideoGenScene>.Filter.Eq(s => s.BackgroundImageStatus, "running")));

        return await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(CancellationToken.None);
    }

    // ─── 路径 5: AI 图生模型生成场景背景图 ───

    private async Task ProcessSceneBgImageGenerationAsync(VideoGenRun run)
    {
        var sceneIdx = run.Scenes.FindIndex(s => s.BackgroundImageStatus == "running");
        if (sceneIdx < 0) return;

        var scene = run.Scenes[sceneIdx];
        _logger.LogInformation("VideoGen 背景图生成: runId={RunId}, sceneIndex={Index}", run.Id, sceneIdx);

        try
        {
            using var scope = _scopeFactory.CreateScope();
            var imageClient = scope.ServiceProvider.GetRequiredService<OpenAIImageClient>();

            // 构建图生提示词：结合 visualDescription + 风格描述
            var imagePrompt = BuildImageGenPrompt(scene, run.StyleDescription);

            var result = await imageClient.GenerateUnifiedAsync(
                prompt: imagePrompt,
                n: 1,
                size: "1792x1024", // 16:9 宽屏，适合视频背景
                responseFormat: "url",
                ct: CancellationToken.None,
                appCallerCode: AppCallerRegistry.VideoAgent.Image.Text2Img);

            if (!result.Success || result.Data?.Images.FirstOrDefault() == null)
            {
                throw new InvalidOperationException($"图生模型返回失败: {result.Error?.Message}");
            }

            var imageUrl = result.Data.Images[0].Url ?? result.Data.Images[0].OriginalUrl;
            if (string.IsNullOrWhiteSpace(imageUrl) && !string.IsNullOrWhiteSpace(result.Data.Images[0].Base64))
            {
                // 如果返回 base64，需要存为文件
                imageUrl = $"data:image/png;base64,{result.Data.Images[0].Base64}";
            }

            // 使用位置索引更新，避免覆盖其他正在并行处理的分镜
            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update
                    .Set($"Scenes.{sceneIdx}.BackgroundImageUrl", imageUrl)
                    .Set($"Scenes.{sceneIdx}.BackgroundImageStatus", "done"),
                cancellationToken: CancellationToken.None);

            _logger.LogInformation("VideoGen 背景图完成: runId={RunId}, scene={Index}", run.Id, sceneIdx);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "VideoGen 背景图生成失败: runId={RunId}, scene={Index}", run.Id, sceneIdx);

            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update
                    .Set($"Scenes.{sceneIdx}.BackgroundImageStatus", "error")
                    .Set($"Scenes.{sceneIdx}.BackgroundImageUrl", (string?)null),
                cancellationToken: CancellationToken.None);
        }
    }

    /// <summary>构建图生提示词：将 visualDescription 转化为图生模型的有效 prompt</summary>
    private static string BuildImageGenPrompt(VideoGenScene scene, string? styleDescription)
    {
        var sb = new StringBuilder();
        sb.Append($"A cinematic 16:9 widescreen illustration for a tech tutorial video scene. ");
        sb.Append($"Topic: {scene.Topic}. ");
        sb.Append($"Visual elements: {scene.VisualDescription}. ");
        sb.Append("Style: dark futuristic tech theme, clean layout, high contrast, ");
        sb.Append("suitable as video background with space for text overlay. ");
        sb.Append("No text, no watermarks, no UI elements. ");

        if (!string.IsNullOrWhiteSpace(styleDescription))
        {
            sb.Append($"Additional style: {styleDescription}. ");
        }

        return sb.ToString();
    }

    // ─── 路径 6: TTS 音频生成 ───

    private async Task<VideoGenRun?> FindEditingRunWithPendingAudioAsync(CancellationToken ct)
    {
        var filter = Builders<VideoGenRun>.Filter.And(
            Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Editing),
            Builders<VideoGenRun>.Filter.ElemMatch(x => x.Scenes,
                Builders<VideoGenScene>.Filter.Eq(s => s.AudioStatus, "running")));

        return await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(CancellationToken.None);
    }

    private async Task<VideoGenRun?> FindEditingRunWithPendingCodegenAsync(CancellationToken ct)
    {
        var filter = Builders<VideoGenRun>.Filter.And(
            Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Editing),
            Builders<VideoGenRun>.Filter.ElemMatch(x => x.Scenes,
                Builders<VideoGenScene>.Filter.Eq(s => s.CodeStatus, "running")));

        return await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(CancellationToken.None);
    }

    private async Task ProcessSceneAudioGenerationAsync(VideoGenRun run)
    {
        var sceneIdx = run.Scenes.FindIndex(s => s.AudioStatus == "running");
        if (sceneIdx < 0) return;

        var scene = run.Scenes[sceneIdx];
        if (string.IsNullOrWhiteSpace(scene.Narration))
        {
            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIdx}.AudioStatus", "done"),
                cancellationToken: CancellationToken.None);
            return;
        }

        _logger.LogInformation("VideoGen TTS 音频生成: runId={RunId}, sceneIndex={Index}, narrationLen={Len}",
            run.Id, sceneIdx, scene.Narration.Length);

        try
        {
            using var scope = _scopeFactory.CreateScope();
            var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();

            // 构建 TTS 请求（OpenAI 兼容格式）
            var requestBody = new JsonObject
            {
                ["input"] = scene.Narration,
                ["voice"] = run.VoiceId ?? "alloy",
                ["response_format"] = "mp3"
            };

            var ttsRequest = new GatewayRawRequest
            {
                AppCallerCode = AppCallerRegistry.VideoAgent.Audio.Tts,
                ModelType = ModelTypes.Tts,
                RequestBody = requestBody,
                TimeoutSeconds = 120
            };

            var ttsResponse = await gateway.SendRawAsync(ttsRequest, CancellationToken.None);

            if (!ttsResponse.Success || ttsResponse.BinaryContent == null || ttsResponse.BinaryContent.Length == 0)
            {
                throw new InvalidOperationException(
                    $"TTS 生成失败: {ttsResponse.ErrorMessage ?? "无音频数据返回"}");
            }

            // 上传音频到存储
            RegistryAssetStorage.OverrideNextScope("generated");
            var stored = await _assetStorage.SaveAsync(
                ttsResponse.BinaryContent, "audio/mpeg", CancellationToken.None,
                domain: "video-gen", type: "audio");
            var audioUrl = stored.Url;

            // 使用位置索引更新，避免覆盖其他正在并行处理的分镜
            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update
                    .Set($"Scenes.{sceneIdx}.AudioUrl", audioUrl)
                    .Set($"Scenes.{sceneIdx}.AudioStatus", "done")
                    .Set($"Scenes.{sceneIdx}.AudioErrorMessage", (string?)null),
                cancellationToken: CancellationToken.None);

            // 发布事件
            using var eventScope = _scopeFactory.CreateScope();
            var runStore = eventScope.ServiceProvider.GetRequiredService<IRunEventStore>();
            await runStore.AppendEventAsync(RunKinds.VideoGen, run.Id, "scene.audio.done",
                new { sceneIndex = sceneIdx, audioUrl },
                ttl: TimeSpan.FromHours(2), ct: CancellationToken.None);

            _logger.LogInformation("VideoGen TTS 音频完成: runId={RunId}, scene={Index}, audioLen={Len}bytes",
                run.Id, sceneIdx, ttsResponse.BinaryContent.Length);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "VideoGen TTS 音频生成失败: runId={RunId}, scene={Index}", run.Id, sceneIdx);

            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update
                    .Set($"Scenes.{sceneIdx}.AudioStatus", "error")
                    .Set($"Scenes.{sceneIdx}.AudioErrorMessage", ex.Message)
                    .Set($"Scenes.{sceneIdx}.AudioUrl", (string?)null),
                cancellationToken: CancellationToken.None);
        }
    }

    // ─── 路径 4: Remotion 渲染单场景预览视频 ───

    private async Task ProcessScenePreviewRenderAsync(VideoGenRun run)
    {
        var sceneIdx = run.Scenes.FindIndex(s => s.ImageStatus == "running");
        if (sceneIdx < 0) return;

        var scene = run.Scenes[sceneIdx];
        _logger.LogInformation("VideoGen 分镜预览渲染: runId={RunId}, sceneIndex={Index}", run.Id, sceneIdx);

        try
        {
            var videoProjectPath = GetVideoProjectPath();
            var videoWorkDir = GetVideoWorkDir();
            var dataDir = Path.Combine(videoWorkDir, "data");
            Directory.CreateDirectory(dataDir);

            // 写入生成的场景代码到磁盘（如有）
            WriteGeneratedScenesToDisk(run);

            // 构造单场景数据
            var hasCode = scene.CodeStatus == "done" && !string.IsNullOrWhiteSpace(scene.SceneCode);
            var sceneData = new
            {
                title = run.ArticleTitle ?? "技术教程",
                scene = new
                {
                    index = scene.Index,
                    topic = scene.Topic,
                    narration = scene.Narration,
                    visualDescription = scene.VisualDescription,
                    durationSeconds = scene.DurationSeconds,
                    durationInFrames = (int)Math.Ceiling(scene.DurationSeconds * 30),
                    sceneType = scene.SceneType,
                    backgroundImageUrl = scene.BackgroundImageUrl,
                    hasGeneratedCode = hasCode,
                }
            };

            var dataJson = JsonSerializer.Serialize(sceneData, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                WriteIndented = true
            });

            var dataFilePath = Path.Combine(dataDir, $"{run.Id}_scene_{sceneIdx}.json");
            await File.WriteAllTextAsync(dataFilePath, dataJson, CancellationToken.None);

            // 渲染输出
            var outDir = Path.Combine(videoWorkDir, "out");
            Directory.CreateDirectory(outDir);
            var outputMp4 = Path.Combine(outDir, $"{run.Id}_scene_{sceneIdx}.mp4");

            // 调用 Remotion 渲染 SingleScene 组合
            // Windows 上 Process.Start 在 UseShellExecute=false 时找不到 npx，需要用 cmd /c
            var isWindows = OperatingSystem.IsWindows();
            var remotionCmd = $"npx remotion render SingleScene \"{outputMp4}\" --props=\"{dataFilePath}\"";
            var psi = new ProcessStartInfo
            {
                FileName = isWindows ? "cmd" : "npx",
                Arguments = isWindows
                    ? $"/c {remotionCmd}"
                    : $"remotion render SingleScene \"{outputMp4}\" --props=\"{dataFilePath}\"",
                WorkingDirectory = videoProjectPath,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            using var process = Process.Start(psi);
            if (process == null)
                throw new InvalidOperationException("无法启动 Remotion 渲染进程");

            var stderrBuilder = new StringBuilder();
            var stderrTask = Task.Run(async () =>
            {
                while (!process.StandardError.EndOfStream)
                {
                    var line = await process.StandardError.ReadLineAsync();
                    if (line != null) stderrBuilder.AppendLine(line);
                }
            });

            // 消费 stdout（避免管道缓冲区死锁）
            while (!process.StandardOutput.EndOfStream)
            {
                await process.StandardOutput.ReadLineAsync();
            }

            await stderrTask;
            await process.WaitForExitAsync();

            if (process.ExitCode != 0)
                throw new InvalidOperationException($"Remotion 单场景渲染失败 (exit code {process.ExitCode}): {stderrBuilder}");

            // 上传渲染产物到 COS
            var mp4Bytes = await File.ReadAllBytesAsync(outputMp4, CancellationToken.None);
            RegistryAssetStorage.OverrideNextScope("generated");
            var stored = await _assetStorage.SaveAsync(mp4Bytes, "video/mp4", CancellationToken.None,
                domain: AppDomainPaths.DomainVideoAgent, type: AppDomainPaths.TypeVideo);

            _logger.LogInformation("VideoGen 分镜视频已上传 COS: runId={RunId}, scene={Index}, url={Url}, size={Size}",
                run.Id, sceneIdx, stored.Url, stored.SizeBytes);

            // 使用位置索引更新，避免覆盖其他正在并行处理的分镜
            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update
                    .Set($"Scenes.{sceneIdx}.ImageUrl", stored.Url)
                    .Set($"Scenes.{sceneIdx}.ImageStatus", "done"),
                cancellationToken: CancellationToken.None);

            _logger.LogInformation("VideoGen 分镜预览完成: runId={RunId}, scene={Index}, output={Output}",
                run.Id, sceneIdx, outputMp4);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "VideoGen 分镜预览渲染失败: runId={RunId}, scene={Index}", run.Id, sceneIdx);

            // 使用位置索引更新，避免覆盖其他正在并行处理的分镜
            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update
                    .Set($"Scenes.{sceneIdx}.ImageStatus", "error")
                    .Set($"Scenes.{sceneIdx}.ImageUrl", (string?)null),
                cancellationToken: CancellationToken.None);
        }
    }

    // ─── 路径 1: 分镜生成（Queued → Scripting → Editing）───

    private async Task ProcessScriptingAsync(VideoGenRun run)
    {
        if (run.CancelRequested) { await CancelRunAsync(run); return; }

        _logger.LogInformation("VideoGen 分镜生成开始: runId={RunId}", run.Id);

        await UpdatePhaseAsync(run, "scripting", 10);
        await PublishEventAsync(run.Id, "phase.changed", new { phase = "scripting", progress = 10 });

        using var scope = _scopeFactory.CreateScope();
        var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();

        // 构建系统提示词（可能包含用户自定义系统提示词和风格描述）
        var systemPrompt = BuildScriptSystemPrompt(run.SystemPrompt, run.StyleDescription);
        var userPrompt = $"请将以下技术文章转化为视频脚本：\n\n{run.ArticleMarkdown}";

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.Script.Chat,
            ModelType = "chat",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt }
                }
            },
            Stream = true,
            IncludeThinking = true,
            TimeoutSeconds = 120,
            Context = new GatewayRequestContext { UserId = run.OwnerAdminId }
        };

        await UpdatePhaseAsync(run, "scripting", 20);
        await PublishEventAsync(run.Id, "phase.changed", new { phase = "scripting", progress = 20 });

        // ─── 流式接收 + 增量解析分镜 ───
        var scenes = new List<VideoGenScene>();
        var fullText = new StringBuilder();
        var objectBuffer = new StringBuilder();
        var foundArrayStart = false;
        var braceDepth = 0;
        var inString = false;
        var escapeNext = false;
        var thinkingStarted = false;

        await foreach (var chunk in gateway.StreamAsync(request, CancellationToken.None))
        {
            if (chunk.Type == GatewayChunkType.Error)
            {
                throw new InvalidOperationException($"LLM 分镜生成失败: {chunk.Error}");
            }

            // 推送思考过程给前端实时显示
            if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrEmpty(chunk.Content))
            {
                if (!thinkingStarted)
                {
                    thinkingStarted = true;
                    await PublishEventAsync(run.Id, "phase.changed", new { phase = "thinking", progress = 20 });
                }
                await PublishEventAsync(run.Id, "thinking.delta", new { content = chunk.Content });
                continue;
            }

            if (chunk.Type != GatewayChunkType.Text || string.IsNullOrEmpty(chunk.Content))
                continue;

            // 思考结束，开始输出文本
            if (thinkingStarted)
            {
                thinkingStarted = false;
                await PublishEventAsync(run.Id, "phase.changed", new { phase = "scripting", progress = 30 });
            }

            fullText.Append(chunk.Content);

            // 推送原始文本输出给前端
            await PublishEventAsync(run.Id, "text.delta", new { content = chunk.Content });

            // 逐字符解析 JSON 数组中的对象
            foreach (var ch in chunk.Content)
            {
                if (!foundArrayStart)
                {
                    if (ch == '[') foundArrayStart = true;
                    continue;
                }

                // 处理转义字符
                if (escapeNext)
                {
                    if (braceDepth > 0) objectBuffer.Append(ch);
                    escapeNext = false;
                    continue;
                }

                // 在字符串内部
                if (inString)
                {
                    if (braceDepth > 0) objectBuffer.Append(ch);
                    if (ch == '\\') escapeNext = true;
                    else if (ch == '"') inString = false;
                    continue;
                }

                // 不在字符串内
                switch (ch)
                {
                    case '"':
                        inString = true;
                        if (braceDepth > 0) objectBuffer.Append(ch);
                        break;
                    case '{':
                        braceDepth++;
                        objectBuffer.Append(ch);
                        break;
                    case '}':
                        objectBuffer.Append(ch);
                        braceDepth--;
                        if (braceDepth == 0)
                        {
                            // 检测到完整 JSON 对象，尝试解析为分镜
                            var objJson = objectBuffer.ToString();
                            objectBuffer.Clear();
                            await TryAddStreamedSceneAsync(run, scenes, objJson);
                        }
                        break;
                    default:
                        if (braceDepth > 0) objectBuffer.Append(ch);
                        break;
                }
            }
        }

        // 流式解析未产出任何分镜时，回退到全文解析
        if (scenes.Count == 0)
        {
            _logger.LogWarning("VideoGen 流式解析未产出分镜，回退全文解析: runId={RunId}", run.Id);
            var fallback = ParseScenesFromLlmResponse(fullText.ToString());
            foreach (var s in fallback)
            {
                s.Status = SceneItemStatus.Done;
                scenes.Add(s);
            }
            // 一次性保存并通知
            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update.Set(x => x.Scenes, scenes),
                cancellationToken: CancellationToken.None);
            foreach (var s in scenes)
            {
                await PublishSceneAddedEventAsync(run.Id, s, scenes.Count);
            }
        }

        // 最终定稿
        var totalDuration = scenes.Sum(s => s.DurationSeconds);
        var scriptMd = GenerateScriptMarkdown(scenes, run.ArticleTitle);
        var narrationDoc = GenerateNarrationDoc(scenes, run.ArticleTitle);

        // AutoRender 模式：跳过 Editing 直接进入 Rendering
        if (run.AutoRender)
        {
            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update
                    .Set(x => x.Status, VideoGenRunStatus.Rendering)
                    .Set(x => x.Scenes, scenes)
                    .Set(x => x.TotalDurationSeconds, totalDuration)
                    .Set(x => x.ScriptMarkdown, scriptMd)
                    .Set(x => x.NarrationDoc, narrationDoc)
                    .Set(x => x.CurrentPhase, "rendering")
                    .Set(x => x.PhaseProgress, 0),
                cancellationToken: CancellationToken.None);

            await PublishEventAsync(run.Id, "script.done", new
            {
                scenes,
                totalDuration,
                autoRender = true,
                status = VideoGenRunStatus.Rendering
            });

            _logger.LogInformation("VideoGen 分镜生成完成 (AutoRender): runId={RunId}, scenes={Count}, duration={Duration}s → Rendering",
                run.Id, scenes.Count, totalDuration);
            return;
        }

        // 触发场景代码生成：所有分镜的 CodeStatus 设为 running
        foreach (var s in scenes)
        {
            s.CodeStatus = "running";
        }

        // 关键：状态切换为 Editing（等待用户交互）
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Editing)
                .Set(x => x.Scenes, scenes)
                .Set(x => x.TotalDurationSeconds, totalDuration)
                .Set(x => x.ScriptMarkdown, scriptMd)
                .Set(x => x.NarrationDoc, narrationDoc)
                .Set(x => x.CurrentPhase, "editing")
                .Set(x => x.PhaseProgress, 100),
            cancellationToken: CancellationToken.None);

        await PublishEventAsync(run.Id, "script.done", new
        {
            scenes,
            totalDuration,
            status = VideoGenRunStatus.Editing
        });

        _logger.LogInformation("VideoGen 分镜生成完成: runId={RunId}, scenes={Count}, duration={Duration}s → Editing",
            run.Id, scenes.Count, totalDuration);
    }

    /// <summary>
    /// 尝试将流式解析到的 JSON 对象作为分镜添加到列表，同时增量保存到 DB 并发布 SSE 事件
    /// </summary>
    private async Task TryAddStreamedSceneAsync(VideoGenRun run, List<VideoGenScene> scenes, string objectJson)
    {
        try
        {
            var scene = JsonSerializer.Deserialize<VideoGenScene>(objectJson, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });
            if (scene == null) return;

            scene.Index = scenes.Count;
            var charCount = scene.Narration?.Length ?? 0;
            scene.DurationSeconds = Math.Max(3, Math.Round(charCount / CharsPerSecond, 1));
            scene.Status = SceneItemStatus.Done;
            scenes.Add(scene);

            // 增量保存到 DB
            var progress = Math.Min(20 + scenes.Count * 7, 90);
            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update
                    .Set(x => x.Scenes, scenes.ToList())
                    .Set(x => x.PhaseProgress, progress),
                cancellationToken: CancellationToken.None);

            // 发布 scene.added 事件
            await PublishSceneAddedEventAsync(run.Id, scene, scenes.Count);

            _logger.LogInformation("VideoGen 流式分镜 #{Index}: topic={Topic}, type={Type}",
                scene.Index, scene.Topic, scene.SceneType);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "VideoGen 流式分镜 JSON 解析失败: {Json}", objectJson[..Math.Min(objectJson.Length, 200)]);
        }
    }

    /// <summary>
    /// 发布 scene.added SSE 事件
    /// </summary>
    private async Task PublishSceneAddedEventAsync(string runId, VideoGenScene scene, int totalScenes)
    {
        await PublishEventAsync(runId, "scene.added", new
        {
            scene = new
            {
                scene.Index,
                scene.Topic,
                scene.Narration,
                scene.VisualDescription,
                scene.DurationSeconds,
                scene.SceneType,
                status = scene.Status,
                imageStatus = "idle",
                backgroundImageStatus = "idle",
            },
            totalScenes,
        });
    }

    // ─── 路径 2: 视频渲染（Rendering → Completed）───

    private async Task ProcessRenderingAsync(VideoGenRun run)
    {
        if (run.CancelRequested) { await CancelRunAsync(run); return; }

        _logger.LogInformation("VideoGen 渲染开始: runId={RunId}, scenes={Count}", run.Id, run.Scenes.Count);

        // 2a: 生成 Remotion 数据文件
        await UpdatePhaseAsync(run, "rendering", 5);
        await PublishEventAsync(run.Id, "phase.changed", new { phase = "rendering", progress = 5 });

        var videoProjectPath = GetVideoProjectPath();
        var videoWorkDir = GetVideoWorkDir();
        var dataDir = Path.Combine(videoWorkDir, "data");
        Directory.CreateDirectory(dataDir);

        // 写入生成的场景代码到磁盘（如有）
        WriteGeneratedScenesToDisk(run);

        var videoData = new
        {
            title = run.ArticleTitle ?? "技术教程",
            fps = 30,
            width = 1920,
            height = 1080,
            scenes = run.Scenes.Select(s => new
            {
                index = s.Index,
                topic = s.Topic,
                narration = s.Narration,
                visualDescription = s.VisualDescription,
                durationSeconds = s.DurationSeconds,
                durationInFrames = (int)Math.Ceiling(s.DurationSeconds * 30),
                sceneType = s.SceneType,
                backgroundImageUrl = s.BackgroundImageUrl,
                audioUrl = s.AudioUrl,
                hasGeneratedCode = s.CodeStatus == "done" && !string.IsNullOrWhiteSpace(s.SceneCode),
            }).ToList(),
            enableTts = run.EnableTts
        };

        var dataJson = JsonSerializer.Serialize(videoData, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true
        });

        var dataFilePath = Path.Combine(dataDir, $"{run.Id}.json");
        await File.WriteAllTextAsync(dataFilePath, dataJson, CancellationToken.None);

        // 2b: 根据 OutputFormat 选择渲染方式
        var outDir = Path.Combine(videoWorkDir, "out");
        Directory.CreateDirectory(outDir);

        string assetUrl;

        if (run.OutputFormat == "html")
        {
            // HTML 模式：生成自包含 HTML 播放页面（嵌入 JSON 数据 + 场景展示）
            await UpdatePhaseAsync(run, "rendering", 10);
            var htmlContent = GenerateHtmlPlayer(dataJson, run);
            var htmlBytes = Encoding.UTF8.GetBytes(htmlContent);
            RegistryAssetStorage.OverrideNextScope("generated");
            var htmlStored = await _assetStorage.SaveAsync(htmlBytes, "text/html", CancellationToken.None,
                domain: AppDomainPaths.DomainVideoAgent, type: AppDomainPaths.TypeVideo);
            assetUrl = htmlStored.Url;

            await UpdatePhaseAsync(run, "rendering", 90);
            _logger.LogInformation("VideoGen HTML 已上传 COS: runId={RunId}, url={Url}, size={Size}",
                run.Id, htmlStored.Url, htmlStored.SizeBytes);
        }
        else
        {
            // MP4 模式：执行 Remotion 渲染
            var outputMp4 = Path.Combine(outDir, $"{run.Id}.mp4");
            await UpdatePhaseAsync(run, "rendering", 10);
            await RunRemotionRenderAsync(run, videoProjectPath, dataFilePath, outputMp4);

            var videoBytes = await File.ReadAllBytesAsync(outputMp4, CancellationToken.None);
            RegistryAssetStorage.OverrideNextScope("generated");
            var videoStored = await _assetStorage.SaveAsync(videoBytes, "video/mp4", CancellationToken.None,
                domain: AppDomainPaths.DomainVideoAgent, type: AppDomainPaths.TypeVideo);
            assetUrl = videoStored.Url;

            _logger.LogInformation("VideoGen 完整视频已上传 COS: runId={RunId}, url={Url}, size={Size}",
                run.Id, videoStored.Url, videoStored.SizeBytes);
        }

        // 2c: 生成 SRT 字幕
        var srtContent = GenerateSrt(run.Scenes);
        var srtFilePath = Path.Combine(outDir, $"{run.Id}.srt");
        await File.WriteAllTextAsync(srtFilePath, srtContent, Encoding.UTF8, CancellationToken.None);

        // 2d: 重新生成文档（使用用户编辑后的最终分镜）
        var scriptMd = GenerateScriptMarkdown(run.Scenes, run.ArticleTitle);
        var narrationDoc = GenerateNarrationDoc(run.Scenes, run.ArticleTitle);

        // 2e: 完成
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Completed)
                .Set(x => x.VideoAssetUrl, assetUrl)
                .Set(x => x.SrtContent, srtContent)
                .Set(x => x.ScriptMarkdown, scriptMd)
                .Set(x => x.NarrationDoc, narrationDoc)
                .Set(x => x.CurrentPhase, "completed")
                .Set(x => x.PhaseProgress, 100)
                .Set(x => x.EndedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        await PublishEventAsync(run.Id, "run.completed", new
        {
            videoUrl = assetUrl,
            totalDuration = run.TotalDurationSeconds,
            scenesCount = run.Scenes.Count,
        });

        // 渲染完成后清理磁盘上的生成文件
        CleanupGeneratedScenes();

        _logger.LogInformation("VideoGen 渲染完成: runId={RunId}", run.Id);
    }

    // ─── 路径 3: 单条分镜重新生成 ───

    private async Task ProcessSceneRegenerationAsync(VideoGenRun run)
    {
        // 找到第一个 Generating 状态的分镜
        var sceneIdx = run.Scenes.FindIndex(s => s.Status == SceneItemStatus.Generating);
        if (sceneIdx < 0) return;

        var scene = run.Scenes[sceneIdx];
        _logger.LogInformation("VideoGen 分镜重试: runId={RunId}, sceneIndex={Index}", run.Id, sceneIdx);

        try
        {
            using var scope = _scopeFactory.CreateScope();
            var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();

            var systemPrompt = BuildSceneRegeneratePrompt(run.SystemPrompt, run.StyleDescription);
            var userPrompt = $"""
                请重新生成以下分镜的内容。

                原始文章片段或上下文：
                {run.ArticleMarkdown[..Math.Min(run.ArticleMarkdown.Length, 2000)]}

                当前分镜信息：
                - 序号：{scene.Index + 1}/{run.Scenes.Count}
                - 主题：{scene.Topic}
                - 类型：{scene.SceneType}
                - 旁白：{scene.Narration}

                请优化此分镜，输出格式同标准分镜 JSON（单个对象，不是数组）。
                """;

            var request = new GatewayRequest
            {
                AppCallerCode = AppCallerRegistry.VideoAgent.Script.Chat,
                ModelType = "chat",
                RequestBody = new JsonObject
                {
                    ["messages"] = new JsonArray
                    {
                        new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                        new JsonObject { ["role"] = "user", ["content"] = userPrompt }
                    }
                },
                Stream = false,
                TimeoutSeconds = 60,
                Context = new GatewayRequestContext { UserId = run.OwnerAdminId }
            };

            var response = await gateway.SendAsync(request, CancellationToken.None);
            if (!response.Success)
            {
                throw new InvalidOperationException($"LLM 分镜重试失败: {response.ErrorMessage}");
            }

            // 解析单条分镜
            var newScene = ParseSingleSceneFromLlmResponse(response.Content);
            newScene.Index = sceneIdx;
            newScene.Status = SceneItemStatus.Done;

            run.Scenes[sceneIdx] = newScene;
            var totalDuration = run.Scenes.Sum(s => s.DurationSeconds);

            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update
                    .Set(x => x.Scenes, run.Scenes)
                    .Set(x => x.TotalDurationSeconds, totalDuration),
                cancellationToken: CancellationToken.None);

            await PublishEventAsync(run.Id, "scene.regenerated", new
            {
                sceneIndex = sceneIdx,
                scene = newScene,
                totalDuration
            });

            _logger.LogInformation("VideoGen 分镜重试完成: runId={RunId}, sceneIndex={Index}", run.Id, sceneIdx);
        }
        catch (Exception ex)
        {
            // 标记分镜为 Error，不影响其他分镜
            run.Scenes[sceneIdx].Status = SceneItemStatus.Error;
            run.Scenes[sceneIdx].ErrorMessage = ex.Message;

            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update.Set(x => x.Scenes, run.Scenes),
                cancellationToken: CancellationToken.None);

            await PublishEventAsync(run.Id, "scene.error", new
            {
                sceneIndex = sceneIdx,
                error = ex.Message
            });
        }
    }

    // ─── Helper Methods ───

    private async Task RunRemotionRenderAsync(VideoGenRun run, string projectPath, string dataFile, string outputMp4)
    {
        var isWindows = OperatingSystem.IsWindows();
        var remotionCmd = $"npx remotion render TutorialVideo \"{outputMp4}\" --props=\"{dataFile}\"";
        var psi = new ProcessStartInfo
        {
            FileName = isWindows ? "cmd" : "npx",
            Arguments = isWindows
                ? $"/c {remotionCmd}"
                : $"remotion render TutorialVideo \"{outputMp4}\" --props=\"{dataFile}\"",
            WorkingDirectory = projectPath,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var process = Process.Start(psi);
        if (process == null)
        {
            throw new InvalidOperationException("无法启动 Remotion 渲染进程");
        }

        // 必须并发消费 stdout 和 stderr，否则 OS 管道缓冲区满后进程会死锁
        var stderrBuilder = new StringBuilder();
        var stderrTask = Task.Run(async () =>
        {
            while (!process.StandardError.EndOfStream)
            {
                var line = await process.StandardError.ReadLineAsync();
                if (line != null) stderrBuilder.AppendLine(line);
            }
        });

        var lastProgress = 0;
        while (!process.StandardOutput.EndOfStream)
        {
            var line = await process.StandardOutput.ReadLineAsync();
            if (line == null) continue;

            if (line.Contains('%'))
            {
                var pctIdx = line.IndexOf('%');
                if (pctIdx > 0)
                {
                    var start = pctIdx - 1;
                    while (start > 0 && char.IsDigit(line[start - 1])) start--;
                    if (int.TryParse(line[start..pctIdx], out var pct) && pct > lastProgress)
                    {
                        lastProgress = pct;
                        // 渲染进度映射到 10-95 区间
                        var mappedProgress = 10 + (int)(pct * 0.85);
                        await UpdatePhaseAsync(run, "rendering", mappedProgress);
                        await PublishEventAsync(run.Id, "render.progress", new { percent = mappedProgress });
                    }
                }
            }
        }

        await stderrTask;
        await process.WaitForExitAsync();

        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"Remotion 渲染失败 (exit code {process.ExitCode}): {stderrBuilder}");
        }
    }

    private static string BuildScriptSystemPrompt(string? userSystemPrompt, string? styleDescription)
    {
        var sb = new StringBuilder();
        sb.AppendLine("""
            你是一个专业的技术视频脚本编写者。你的任务是将技术文章转化为8-10个视频镜头的脚本。

            请严格按照以下 JSON 格式输出，不要包含任何其他文字：

            ```json
            [
              {
                "index": 0,
                "topic": "镜头主题（一句话概括）",
                "narration": "旁白文本（朗读的台词）",
                "visualDescription": "画面描述（该镜头展示的视觉元素）",
                "sceneType": "intro"
              }
            ]
            ```

            sceneType 可选值：
            - intro: 开场介绍
            - concept: 概念解释
            - steps: 步骤演示
            - code: 代码展示
            - comparison: 对比说明
            - diagram: 图表/架构
            - summary: 总结回顾
            - outro: 结尾

            规则：
            1. 第一个镜头必须是 intro 类型，最后一个必须是 outro 类型
            2. 旁白文本要口语化、自然，适合朗读
            3. 每个镜头的旁白控制在 20-60 字之间
            4. 画面描述要具体，包含可视化的元素（标题、卡片、代码块、流程图等）
            5. 确保所有关键信息都被覆盖，不遗漏重要内容
            6. 只输出 JSON 数组，不要包含 markdown 代码块标记
            7. **所有输出必须使用中文**，包括 topic、narration 和 visualDescription，即使原文是英文也要翻译为中文
            """);

        if (!string.IsNullOrWhiteSpace(userSystemPrompt))
        {
            sb.AppendLine();
            sb.AppendLine("额外指导要求：");
            sb.AppendLine(userSystemPrompt);
        }

        if (!string.IsNullOrWhiteSpace(styleDescription))
        {
            sb.AppendLine();
            sb.AppendLine("视觉风格要求：");
            sb.AppendLine(styleDescription);
        }

        return sb.ToString();
    }

    private static string BuildSceneRegeneratePrompt(string? userSystemPrompt, string? styleDescription)
    {
        var sb = new StringBuilder();
        sb.AppendLine("""
            你是一个专业的技术视频脚本编写者。请优化给定的分镜，改善旁白和画面描述。

            输出格式为单个 JSON 对象（不是数组）：
            ```json
            {
              "topic": "优化后的主题",
              "narration": "优化后的旁白",
              "visualDescription": "优化后的画面描述",
              "sceneType": "保持原类型或优化"
            }
            ```

            所有输出必须使用中文，即使原文是英文也要翻译为中文。
            只输出 JSON，不要包含其他文字。
            """);

        if (!string.IsNullOrWhiteSpace(userSystemPrompt))
        {
            sb.AppendLine();
            sb.AppendLine("额外指导要求：");
            sb.AppendLine(userSystemPrompt);
        }

        if (!string.IsNullOrWhiteSpace(styleDescription))
        {
            sb.AppendLine();
            sb.AppendLine("视觉风格要求：");
            sb.AppendLine(styleDescription);
        }

        return sb.ToString();
    }

    /// <summary>
    /// 从 Gateway SendAsync 返回的原始 HTTP 响应体中提取 LLM 生成的文本内容。
    /// SendAsync 返回原始响应 JSON（如 OpenAI 格式 {"choices":[{"message":{"content":"..."}}]}），
    /// 需要先提取 message.content，再剥离 DeepSeek-R1 等推理模型的 &lt;think&gt; 标签。
    /// </summary>
    private static string ExtractLlmContent(string rawResponseBody)
    {
        var text = rawResponseBody.Trim();

        // 尝试从 OpenAI 格式 JSON 中提取 choices[0].message.content
        if (text.StartsWith("{"))
        {
            try
            {
                using var doc = JsonDocument.Parse(text);
                var root = doc.RootElement;
                if (root.TryGetProperty("choices", out var choices)
                    && choices.GetArrayLength() > 0)
                {
                    var firstChoice = choices[0];
                    if (firstChoice.TryGetProperty("message", out var message)
                        && message.TryGetProperty("content", out var content))
                    {
                        text = content.GetString() ?? "";
                    }
                }
            }
            catch (JsonException)
            {
                // 不是标准 OpenAI 格式，保持原样继续解析
            }
        }

        // 剥离 DeepSeek-R1 等模型的 <think>...</think> 推理标签
        text = Regex.Replace(text, @"<think>[\s\S]*?</think>", "", RegexOptions.IgnoreCase).Trim();

        return text;
    }

    private static List<VideoGenScene> ParseScenesFromLlmResponse(string content)
    {
        var jsonContent = ExtractLlmContent(content);

        if (jsonContent.StartsWith("```"))
        {
            var firstNewline = jsonContent.IndexOf('\n');
            if (firstNewline > 0) jsonContent = jsonContent[(firstNewline + 1)..];
            if (jsonContent.EndsWith("```")) jsonContent = jsonContent[..^3];
            jsonContent = jsonContent.Trim();
        }

        var startIdx = jsonContent.IndexOf('[');
        var endIdx = jsonContent.LastIndexOf(']');
        if (startIdx >= 0 && endIdx > startIdx)
        {
            jsonContent = jsonContent[startIdx..(endIdx + 1)];
        }

        var parsed = JsonSerializer.Deserialize<List<VideoGenScene>>(jsonContent, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        });

        if (parsed == null || parsed.Count == 0)
        {
            throw new InvalidOperationException("LLM 返回的脚本格式无效：未解析到任何场景");
        }

        for (var i = 0; i < parsed.Count; i++)
        {
            parsed[i].Index = i;
            var charCount = parsed[i].Narration?.Length ?? 0;
            parsed[i].DurationSeconds = Math.Max(3, Math.Round(charCount / CharsPerSecond, 1));
        }

        return parsed;
    }

    private static VideoGenScene ParseSingleSceneFromLlmResponse(string content)
    {
        var jsonContent = ExtractLlmContent(content);

        if (jsonContent.StartsWith("```"))
        {
            var firstNewline = jsonContent.IndexOf('\n');
            if (firstNewline > 0) jsonContent = jsonContent[(firstNewline + 1)..];
            if (jsonContent.EndsWith("```")) jsonContent = jsonContent[..^3];
            jsonContent = jsonContent.Trim();
        }

        var startIdx = jsonContent.IndexOf('{');
        var endIdx = jsonContent.LastIndexOf('}');
        if (startIdx >= 0 && endIdx > startIdx)
        {
            jsonContent = jsonContent[startIdx..(endIdx + 1)];
        }

        var parsed = JsonSerializer.Deserialize<VideoGenScene>(jsonContent, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        });

        if (parsed == null)
        {
            throw new InvalidOperationException("LLM 返回的分镜格式无效");
        }

        var charCount = parsed.Narration?.Length ?? 0;
        parsed.DurationSeconds = Math.Max(3, Math.Round(charCount / CharsPerSecond, 1));

        return parsed;
    }

    private static string GenerateScriptMarkdown(List<VideoGenScene> scenes, string? title)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# 视频脚本：{title ?? "技术教程"}");
        sb.AppendLine();
        sb.AppendLine($"**总时长**：{scenes.Sum(s => s.DurationSeconds):F1} 秒 ({scenes.Sum(s => s.DurationSeconds) / 60:F1} 分钟)");
        sb.AppendLine($"**镜头数**：{scenes.Count}");
        sb.AppendLine();

        foreach (var scene in scenes)
        {
            sb.AppendLine($"## 镜头 {scene.Index + 1}：{scene.Topic}");
            sb.AppendLine();
            sb.AppendLine($"- **类型**：{scene.SceneType}");
            sb.AppendLine($"- **时长**：{scene.DurationSeconds:F1}s（{scene.Narration.Length} 字）");
            sb.AppendLine($"- **旁白**：{scene.Narration}");
            sb.AppendLine($"- **画面**：{scene.VisualDescription}");
            sb.AppendLine();
        }

        return sb.ToString();
    }

    private static string GenerateNarrationDoc(List<VideoGenScene> scenes, string? title)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# 剪映配音台词：{title ?? "技术教程"}");
        sb.AppendLine();
        sb.AppendLine("> 以下为每个镜头的配音台词和建议语气。总时长约 " +
            $"{scenes.Sum(s => s.DurationSeconds) / 60:F1} 分钟。");
        sb.AppendLine();

        double cumTime = 0;
        foreach (var scene in scenes)
        {
            var startTs = TimeSpan.FromSeconds(cumTime);
            var endTs = TimeSpan.FromSeconds(cumTime + scene.DurationSeconds);
            sb.AppendLine($"### [{startTs:mm\\:ss} - {endTs:mm\\:ss}] 镜头 {scene.Index + 1}：{scene.Topic}");
            sb.AppendLine();

            var tone = scene.SceneType switch
            {
                "intro" => "热情、引导性",
                "concept" => "平稳、解释性",
                "steps" => "清晰、条理性",
                "code" => "专注、技术性",
                "comparison" => "对比、强调差异",
                "diagram" => "描述性、指引性",
                "summary" => "总结、回顾性",
                "outro" => "收尾、鼓励性",
                _ => "自然"
            };

            sb.AppendLine($"**语气**：{tone}");
            sb.AppendLine();
            sb.AppendLine($"> {scene.Narration}");
            sb.AppendLine();
            cumTime += scene.DurationSeconds;
        }

        return sb.ToString();
    }

    /// <summary>
    /// 生成自包含 HTML 播放页面，将场景数据嵌入为交互式幻灯片展示
    /// </summary>
    private static string GenerateHtmlPlayer(string dataJson, VideoGenRun run)
    {
        var title = System.Net.WebUtility.HtmlEncode(run.ArticleTitle ?? "技术教程");
        return $$"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{title}}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e8e8e8;min-height:100vh;display:flex;flex-direction:column;align-items:center}
.header{padding:2rem;text-align:center;max-width:900px}
.header h1{font-size:1.8rem;margin-bottom:.5rem}
.header p{color:#888;font-size:.9rem}
.scene-container{max-width:900px;width:100%;padding:0 1.5rem 3rem}
.scene{background:#1a1a1a;border-radius:12px;margin-bottom:1.5rem;overflow:hidden;border:1px solid #2a2a2a;transition:border-color .2s}
.scene:hover{border-color:#444}
.scene-header{display:flex;align-items:center;gap:.75rem;padding:1rem 1.25rem;background:#111;border-bottom:1px solid #2a2a2a}
.scene-num{background:#333;color:#ccc;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:600;flex-shrink:0}
.scene-topic{font-weight:600;font-size:1rem}
.scene-dur{margin-left:auto;color:#666;font-size:.8rem}
.scene-body{padding:1.25rem}
.scene-body .narration{line-height:1.7;margin-bottom:1rem;color:#ccc}
.scene-body .visual{color:#888;font-size:.85rem;font-style:italic;padding:.75rem;background:#111;border-radius:8px}
.bg-img{width:100%;max-height:400px;object-fit:cover}
.controls{position:fixed;bottom:0;left:0;right:0;background:rgba(10,10,10,.95);backdrop-filter:blur(10px);padding:.75rem 1.5rem;display:flex;align-items:center;justify-content:center;gap:1rem;border-top:1px solid #222}
.controls button{background:#333;color:#e8e8e8;border:none;padding:.5rem 1.25rem;border-radius:8px;cursor:pointer;font-size:.85rem}
.controls button:hover{background:#444}
.controls .current{color:#888;font-size:.85rem;min-width:80px;text-align:center}
.scene.active{border-color:#4a9eff}
</style>
</head>
<body>
<div class="header">
  <h1>{{title}}</h1>
  <p>共 <span id="total"></span> 个场景 · 总时长 <span id="duration"></span></p>
</div>
<div class="scene-container" id="scenes"></div>
<div class="controls">
  <button onclick="go(-1)">◀ 上一场景</button>
  <span class="current" id="indicator"></span>
  <button onclick="go(1)">下一场景 ▶</button>
</div>
<script>
const data = {{dataJson}};
let cur = 0;
document.getElementById('total').textContent = data.scenes.length;
document.getElementById('duration').textContent = data.scenes.reduce((s,x)=>s+x.durationSeconds,0).toFixed(1)+'s';
const container = document.getElementById('scenes');
data.scenes.forEach((s,i) => {
  const el = document.createElement('div');
  el.className = 'scene' + (i===0?' active':'');
  el.id = 'scene-'+i;
  el.innerHTML = `<div class="scene-header"><span class="scene-num">${i+1}</span><span class="scene-topic">${esc(s.topic)}</span><span class="scene-dur">${s.durationSeconds}s</span></div>`
    + (s.backgroundImageUrl ? `<img class="bg-img" src="${esc(s.backgroundImageUrl)}" alt="">` : '')
    + `<div class="scene-body"><div class="narration">${esc(s.narration)}</div><div class="visual">${esc(s.visualDescription)}</div></div>`;
  container.appendChild(el);
});
updateIndicator();
function go(d){cur=Math.max(0,Math.min(data.scenes.length-1,cur+d));document.querySelectorAll('.scene').forEach((e,i)=>e.classList.toggle('active',i===cur));document.getElementById('scene-'+cur).scrollIntoView({behavior:'smooth',block:'center'});updateIndicator()}
function updateIndicator(){document.getElementById('indicator').textContent=(cur+1)+' / '+data.scenes.length}
function esc(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML}
document.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowDown')go(1);if(e.key==='ArrowLeft'||e.key==='ArrowUp')go(-1)});
</script>
</body>
</html>
""";
    }

    private static string GenerateSrt(List<VideoGenScene> scenes)
    {
        var sb = new StringBuilder();
        var subtitleIndex = 1;
        double cumTime = 0;

        foreach (var scene in scenes)
        {
            var segments = SplitNarration(scene.Narration, 20);
            var totalChars = segments.Sum(s => s.Length);

            foreach (var seg in segments)
            {
                var ratio = (double)seg.Length / Math.Max(totalChars, 1);
                var segDuration = scene.DurationSeconds * ratio;

                var startTs = TimeSpan.FromSeconds(cumTime);
                var endTs = TimeSpan.FromSeconds(cumTime + segDuration);

                sb.AppendLine(subtitleIndex.ToString());
                sb.AppendLine($"{FormatSrtTime(startTs)} --> {FormatSrtTime(endTs)}");
                sb.AppendLine(seg);
                sb.AppendLine();

                cumTime += segDuration;
                subtitleIndex++;
            }
        }

        return sb.ToString();
    }

    private static List<string> SplitNarration(string text, int maxLen)
    {
        var result = new List<string>();
        if (string.IsNullOrWhiteSpace(text)) return result;

        var delimiters = new[] { '。', '，', '；', '！', '？', '、', '.', ',', ';', '!', '?' };
        var current = new StringBuilder();

        foreach (var ch in text)
        {
            current.Append(ch);
            if (delimiters.Contains(ch) && current.Length >= 5)
            {
                result.Add(current.ToString().Trim());
                current.Clear();
            }
            else if (current.Length >= maxLen)
            {
                result.Add(current.ToString().Trim());
                current.Clear();
            }
        }

        if (current.Length > 0)
        {
            if (result.Count > 0 && current.Length < 5)
            {
                result[^1] += current.ToString().Trim();
            }
            else
            {
                result.Add(current.ToString().Trim());
            }
        }

        return result.Where(s => !string.IsNullOrWhiteSpace(s)).ToList();
    }

    private static string FormatSrtTime(TimeSpan ts)
    {
        return $"{(int)ts.TotalHours:D2}:{ts.Minutes:D2}:{ts.Seconds:D2},{ts.Milliseconds:D3}";
    }

    // ─── 路径 7: LLM 场景代码生成 ───

    private async Task ProcessSceneCodegenAsync(VideoGenRun run)
    {
        var sceneIdx = run.Scenes.FindIndex(s => s.CodeStatus == "running");
        if (sceneIdx < 0) return;

        var scene = run.Scenes[sceneIdx];
        _logger.LogInformation("VideoGen 场景代码生成: runId={RunId}, sceneIndex={Index}, sceneType={Type}",
            run.Id, sceneIdx, scene.SceneType);

        try
        {
            using var scope = _scopeFactory.CreateScope();
            var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();

            var systemPrompt = BuildSceneCodegenSystemPrompt();
            var userPrompt = $$"""
                请为以下视频分镜生成 Remotion 场景组件代码。

                分镜信息：
                - 序号：{{scene.Index + 1}}
                - 主题：{{scene.Topic}}
                - 类型：{{scene.SceneType}}
                - 旁白：{{scene.Narration}}
                - 画面描述：{{scene.VisualDescription}}

                请输出完整的 TypeScript React 组件代码（.tsx），包含所有 import 语句。
                组件必须导出为 default export，接收 { scene: SceneData; videoTitle?: string } props。
                只输出代码，不要包含 markdown 代码块标记或任何解释文字。
                """;

            var request = new GatewayRequest
            {
                AppCallerCode = run.AppKey == "visual-agent"
                    ? AppCallerRegistry.VisualAgent.Scene.Codegen
                    : AppCallerRegistry.VideoAgent.Scene.Codegen,
                ModelType = ModelTypes.Code,
                RequestBody = new JsonObject
                {
                    ["messages"] = new JsonArray
                    {
                        new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                        new JsonObject { ["role"] = "user", ["content"] = userPrompt }
                    }
                },
                Stream = false,
                TimeoutSeconds = 120,
                Context = new GatewayRequestContext { UserId = run.OwnerAdminId }
            };

            var response = await gateway.SendAsync(request, CancellationToken.None);
            if (!response.Success)
            {
                throw new InvalidOperationException($"LLM 场景代码生成失败: {response.ErrorMessage}");
            }

            var sceneCode = ExtractCodeFromLlmResponse(response.Content);
            if (string.IsNullOrWhiteSpace(sceneCode))
            {
                throw new InvalidOperationException("LLM 返回的场景代码为空");
            }

            // 保存生成的代码
            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update
                    .Set($"Scenes.{sceneIdx}.SceneCode", sceneCode)
                    .Set($"Scenes.{sceneIdx}.CodeStatus", "done"),
                cancellationToken: CancellationToken.None);

            await PublishEventAsync(run.Id, "scene.codegen.done", new { sceneIndex = sceneIdx });

            _logger.LogInformation("VideoGen 场景代码生成完成: runId={RunId}, scene={Index}, codeLen={Len}",
                run.Id, sceneIdx, sceneCode.Length);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "VideoGen 场景代码生成失败: runId={RunId}, scene={Index}", run.Id, sceneIdx);

            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update
                    .Set($"Scenes.{sceneIdx}.CodeStatus", "error")
                    .Set($"Scenes.{sceneIdx}.SceneCode", (string?)null),
                cancellationToken: CancellationToken.None);
        }
    }

    /// <summary>
    /// 从 LLM 响应中提取代码内容（剥离 markdown 代码块标记和思考标签）
    /// </summary>
    private static string ExtractCodeFromLlmResponse(string content)
    {
        var text = ExtractLlmContent(content);

        // 剥离 markdown 代码块
        if (text.StartsWith("```"))
        {
            var firstNewline = text.IndexOf('\n');
            if (firstNewline > 0) text = text[(firstNewline + 1)..];
            if (text.EndsWith("```")) text = text[..^3];
            text = text.Trim();
        }

        return text;
    }

    /// <summary>
    /// 将已生成的场景代码写入磁盘，供 Remotion 渲染时使用。
    /// 写入 prd-video/src/scenes/generated/ 目录下的 .tsx 文件和 index.ts 注册表。
    /// </summary>
    private void WriteGeneratedScenesToDisk(VideoGenRun run)
    {
        var videoWorkDir = GetVideoWorkDir();
        var generatedDir = Path.Combine(videoWorkDir, "src", "scenes", "generated");
        Directory.CreateDirectory(generatedDir);

        // 收集有生成代码的场景
        var generatedIndices = new List<int>();
        foreach (var scene in run.Scenes)
        {
            if (scene.CodeStatus == "done" && !string.IsNullOrWhiteSpace(scene.SceneCode))
            {
                var filePath = Path.Combine(generatedDir, $"Scene_{scene.Index}.tsx");
                File.WriteAllText(filePath, scene.SceneCode, Encoding.UTF8);
                generatedIndices.Add(scene.Index);
                _logger.LogDebug("VideoGen 写入生成场景文件: {Path}", filePath);
            }
        }

        // 生成 index.ts 注册表
        var registrySb = new StringBuilder();
        registrySb.AppendLine("// Auto-generated by VideoGenRunWorker — DO NOT EDIT");
        registrySb.AppendLine("import type React from \"react\";");
        registrySb.AppendLine("import type { SceneData } from \"../../types\";");
        registrySb.AppendLine();
        registrySb.AppendLine("export type GeneratedSceneComponent = React.FC<{");
        registrySb.AppendLine("  scene: SceneData;");
        registrySb.AppendLine("  videoTitle?: string;");
        registrySb.AppendLine("}>;");
        registrySb.AppendLine();

        // 使用 try/require 避免单个文件编译错误导致整体崩溃
        registrySb.AppendLine("const registry: Record<number, GeneratedSceneComponent> = {};");
        registrySb.AppendLine();

        foreach (var idx in generatedIndices)
        {
            registrySb.AppendLine($"try {{ const m = require(\"./Scene_{idx}\"); registry[{idx}] = m.default || m.Scene || Object.values(m)[0]; }} catch {{}}");
        }

        registrySb.AppendLine();
        registrySb.AppendLine("export const GENERATED_SCENES = registry;");

        var indexPath = Path.Combine(generatedDir, "index.ts");
        File.WriteAllText(indexPath, registrySb.ToString(), Encoding.UTF8);

        _logger.LogInformation("VideoGen 写入 {Count} 个生成场景文件 + index.ts",
            generatedIndices.Count);
    }

    /// <summary>
    /// 清理磁盘上的生成场景文件（渲染完成后调用）
    /// </summary>
    private void CleanupGeneratedScenes()
    {
        try
        {
            var videoWorkDir = GetVideoWorkDir();
            var generatedDir = Path.Combine(videoWorkDir, "src", "scenes", "generated");

            // 删除所有 Scene_*.tsx 文件
            if (Directory.Exists(generatedDir))
            {
                foreach (var file in Directory.GetFiles(generatedDir, "Scene_*.tsx"))
                {
                    File.Delete(file);
                }
            }

            // 恢复空的 index.ts
            var indexPath = Path.Combine(generatedDir, "index.ts");
            var emptyRegistry = """
                // Auto-generated by VideoGenRunWorker — DO NOT EDIT
                import type React from "react";
                import type { SceneData } from "../../types";

                export type GeneratedSceneComponent = React.FC<{
                  scene: SceneData;
                  videoTitle?: string;
                }>;

                export const GENERATED_SCENES: Record<number, GeneratedSceneComponent> = {};
                """;
            File.WriteAllText(indexPath, emptyRegistry, Encoding.UTF8);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "VideoGen 清理生成场景文件失败");
        }
    }

    /// <summary>
    /// 场景代码生成系统提示词 — 嵌入 Remotion API 知识、组件库和动效工具
    /// </summary>
    private static string BuildSceneCodegenSystemPrompt()
    {
        return """
            你是一个专业的 Remotion 视频场景代码生成器。你的任务是为视频分镜生成高质量的 React 组件代码。

            ## 技术约束

            1. **纯 React + inline style**：不使用 CSS 文件，所有样式内联
            2. **帧驱动动画**：所有动画基于 `useCurrentFrame()` 和 `interpolate` / `spring`，禁止 CSS 动画或 requestAnimationFrame
            3. **30fps 基准**：所有时间计算基于 30fps（1 秒 = 30 帧）
            4. **1920x1080**：画布尺寸固定
            5. **深色主题**：背景色 #0a0a1a，文字白色，强调色用霓虹色系
            6. **退场淡出**：每个场景最后 15 帧使用 sceneFadeOut 做统一淡出
            7. **禁止使用 CSS 动画**（@keyframes, animation, transition）
            8. **禁止使用 setTimeout / setInterval**
            9. **禁止硬编码时长**（使用 durationInFrames 参数）
            10. **禁止直接调用 spring()**：Remotion 的 `spring()` 需要 `frame` 参数，极易遗漏导致渲染崩溃。请一律使用项目封装的 `springIn(frame, fps, delay?, config?)` 替代，它已正确传递 frame。如果确实需要 `spring()`，必须写成 `spring({ frame, fps, config: {...} })`，其中 `frame` 来自 `useCurrentFrame()`

            ## 可用 import

            ```typescript
            // Remotion 核心（注意：不要直接用 spring()，用 springIn() 代替）
            import { useCurrentFrame, useVideoConfig, interpolate, Easing, AbsoluteFill, Sequence, Audio, Img } from "remotion";

            // 项目动效工具库（注意：生成的文件位于 src/scenes/generated/，所以需要 ../../ 回到 src/）
            import {
              springIn, fadeIn, fadeOut, slideInFromBottom, sceneFadeOut,
              typewriterCount, counterValue,
              staggerIn, waveIn,
              elasticIn, bounceIn, backIn,
              pulse, float, rotate, glowPulse,
              circularMotion, easedProgress,
              shimmerScan, ripple,
              kenBurns, vignetteOpacity, cameraZoom, energyRing, flowingDot, focusScale, cursorBlink
            } from "../../utils/animations";

            // 色彩系统
            import { COLORS, getSceneAccentColor } from "../../utils/colors";

            // 可复用组件
            import { Background } from "../../components/Background";
            import { ParticleField } from "../../components/ParticleField";
            import { AnimatedText } from "../../components/AnimatedText";
            import { GlassCard } from "../../components/GlassCard";
            import { CodeBlock } from "../../components/CodeBlock";
            import { CompareCard } from "../../components/CompareCard";
            import { StepFlow } from "../../components/StepFlow";
            import { PathDraw } from "../../components/PathDraw";
            import { NumberCounter } from "../../components/NumberCounter";
            import { ProgressBar } from "../../components/ProgressBar";

            // 类型
            import type { SceneData } from "../../types";
            ```

            ## 动效工具函数说明

            | 函数 | 用途 |
            |------|------|
            | springIn(frame, fps, delay?, config?) | 弹性入场 0→1 |
            | fadeIn(frame, startFrame, duration) | 渐入 0→1 |
            | fadeOut(frame, startFrame, duration) | 渐出 1→0 |
            | slideInFromBottom(frame, fps, delay?) | 底部滑入（返回 px 偏移） |
            | sceneFadeOut(frame, durationInFrames, fadeFrames?) | 场景标准退出 |
            | typewriterCount(frame, text, fps, startFrame?, charsPerSec?) | 打字机效果 |
            | staggerIn(frame, fps, index, staggerFrames?, baseDelay?, config?) | 列表项交错入场 |
            | waveIn(frame, index, total, startFrame?, duration?) | 波浪入场 |
            | elasticIn(frame, fps, delay?) | 弹性过冲 |
            | pulse(frame, period?, min?, max?) | 呼吸脉冲 |
            | float(frame, ampY?, ampX?, speed?, seed?) | 浮动 {x, y} |
            | glowPulse(frame, period?, min?, max?) | 发光脉冲 |
            | cameraZoom(frame, duration, start?, end?) | 摄像机推进 |
            | energyRing(frame, period?, maxR?, delay?) | 能量环 {radius, opacity} |
            | kenBurns(frame, duration, config?) | 缩放平移 {scale, x, y} |
            | cursorBlink(frame, period?) | 光标闪烁 0/1 |

            ## 色彩系统

            ```
            COLORS.bg.primary = "#0a0a1a"
            COLORS.bg.secondary = "#111128"
            COLORS.neon.blue = "#00d4ff"
            COLORS.neon.purple = "#a855f7"
            COLORS.neon.green = "#22c55e"
            COLORS.neon.pink = "#ec4899"
            COLORS.neon.orange = "#f97316"
            COLORS.neon.cyan = "#06b6d4"
            COLORS.text.primary = "#ffffff"
            COLORS.text.secondary = "rgba(255,255,255,0.7)"
            COLORS.text.muted = "rgba(255,255,255,0.4)"
            COLORS.glass.bg = "rgba(255,255,255,0.05)"
            COLORS.glass.border = "rgba(255,255,255,0.1)"
            ```

            ## 可复用组件

            - `<Background scene={scene} durationInFrames={durationInFrames} />` — 背景层
            - `<ParticleField count={40} color="rgba(0,212,255,0.3)" speed={0.5} />` — 粒子装饰
            - `<AnimatedText text="标题" delay={0} fontSize={72} color="#fff" />` — 弹性文字
            - `<GlassCard delay={5}>内容</GlassCard>` — 毛玻璃卡片
            - `<CodeBlock code={code} language="javascript" delay={10} />` — 代码块
            - `<CompareCard side="before" items={[...]} delay={0} accent="#color" />` — 对比卡片
            - `<StepFlow steps={["步骤1"]} activeIndex={idx} />` — 步骤流程
            - `<PathDraw d="M 0 0 L 100 100" color="#00d4ff" duration={30} delay={0} />` — SVG 描边
            - `<NumberCounter target={95} suffix="%" delay={10} />` — 数字计数器
            - `<ProgressBar progress={0.75} color="#22c55e" delay={5} />` — 进度条

            ## SceneData 输入接口

            ```typescript
            interface SceneData {
              index: number;
              topic: string;
              narration: string;
              visualDescription: string;
              durationSeconds: number;
              durationInFrames: number;
              sceneType: SceneType; // "intro"|"concept"|"steps"|"code"|"comparison"|"diagram"|"summary"|"outro"
              backgroundImageUrl?: string;
              audioUrl?: string;
            }
            ```

            ## 8 种场景类型设计原则

            | 类型 | 视觉重点 | 关键动效 |
            |------|----------|----------|
            | intro | 标题居中 + 副标题 + 粒子 | 能量脉冲环、扫描光、标题辉光 |
            | concept | 文字卡片 + 关键词 | 3D 翻转入场、打字机效果、时间线进度条 |
            | steps | 步骤卡片 + 连线 + 进度 | 流光圆点连线、SVG 环形进度、焦点缩放 |
            | code | 代码块 + 行号高亮 | 3D 透视倾斜、光标闪烁、活跃行高亮 |
            | comparison | 左右对比卡 + VS 中间 | 天平倾斜、交错飞入、VS 弹跳能量 |
            | diagram | 节点 + 连线 + 中心元素 | 能量粒子流动、中心波纹、节点浮动 |
            | summary | 数据可视化 + 要点列表 | 三环进度、完成辉光爆发、百分比弹跳 |
            | outro | CTA + 致谢 | 光晕扩散环、字幕滚动 |

            ## 视觉设计原则

            1. **层次分明**：背景层 → 装饰层 → 内容层 → 前景效果层
            2. **动静结合**：主内容有进场动画，背景有持续微动效
            3. **节奏感**：元素交错入场（staggerIn），不同时出现
            4. **呼吸感**：使用 pulse/glowPulse 让静态元素有生命力
            5. **电影感**：cameraZoom 缓慢推进 + vignetteOpacity 暗角
            6. **克制**：动效服务于内容，不喧宾夺主

            ## 输出要求

            1. 输出完整的 .tsx 文件，包含所有 import
            2. 组件必须 export default
            3. 组件 props 类型：`{ scene: SceneData; videoTitle?: string }`
            4. 根据分镜的 topic、narration、visualDescription 智能提取关键词并设计视觉布局
            5. 从旁白中提取要点，用卡片、列表等方式呈现
            6. 必须包含 sceneFadeOut 退场效果
            7. 只输出代码，不要任何解释文字
            """;
    }

    private string GetVideoProjectPath()
    {
        var path = _configuration["VideoAgent:RemotionProjectPath"];
        if (string.IsNullOrWhiteSpace(path))
        {
            // AppContext.BaseDirectory = .../prd-api/src/PrdAgent.Api/bin/Debug/net8.0/
            // 需要向上 6 级到项目根目录，再进 prd-video
            var baseDir = AppContext.BaseDirectory;
            path = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", "..", "..", "prd-video"));
        }
        return path;
    }

    /// <summary>
    /// 获取视频生成的可写工作目录。
    /// Docker 容器中文件系统为只读（read_only: true），只有 /tmp 可写。
    /// 本地开发时直接使用 prd-video 项目目录。
    /// </summary>
    private string GetVideoWorkDir()
    {
        var workDir = _configuration["VideoAgent:WorkDir"];
        if (!string.IsNullOrWhiteSpace(workDir))
            return workDir;

        var videoProjectPath = GetVideoProjectPath();
        try
        {
            // 尝试在项目目录创建测试目录，判断是否可写
            var testDir = Path.Combine(videoProjectPath, ".write-test");
            Directory.CreateDirectory(testDir);
            Directory.Delete(testDir);
            return videoProjectPath;
        }
        catch (IOException)
        {
            // 只读文件系统（Docker read_only: true），回退到 /tmp
            var tmpWorkDir = Path.Combine(Path.GetTempPath(), "prd-video-work");
            Directory.CreateDirectory(tmpWorkDir);
            return tmpWorkDir;
        }
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

    // ─── 直出视频生成（OpenRouter） ───

    /// <summary>
    /// videogen 模式：提交 → 轮询 → 写回 VideoAssetUrl → Completed
    /// 使用 CancellationToken.None（服务器权威原则）
    ///
    /// 走 ILlmGateway.SendRawAsync（由 Client 内部使用），
    /// AppCallerCode = "video-agent.videogen::video-gen" 决定模型池，
    /// 平台 ApiKey 从平台管理中配置的凭据自动取用，不依赖环境变量。
    /// </summary>
    private async Task ProcessDirectVideoGenAsync(VideoGenRun run)
    {
        const string appCallerCode = PrdAgent.Core.Models.AppCallerRegistry.VideoAgent.VideoGen.Generate;

        _logger.LogInformation("VideoGen 直出开始: runId={RunId}, userModel={Model}, duration={Duration}s",
            run.Id, run.DirectVideoModel, run.DirectDuration);

        await PublishEventAsync(run.Id, "phase.changed", new { phase = "videogen-submitting", progress = 5 });

        using var scope = _scopeFactory.CreateScope();
        var client = scope.ServiceProvider.GetRequiredService<PrdAgent.Core.Interfaces.IOpenRouterVideoClient>();

        // ─── 提交任务（Client 内部调 Gateway 解析模型池 + 发起请求） ───
        var submitReq = new PrdAgent.Core.Interfaces.OpenRouterVideoSubmitRequest
        {
            AppCallerCode = appCallerCode,
            Model = run.DirectVideoModel, // 用户偏好（可空）；由模型池决定最终选择
            Prompt = run.DirectPrompt ?? string.Empty,
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

        // 把 Gateway 解析出来的实际模型 id 回写到 Run 上（便于前端展示"本次用的是哪个模型"）
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

        await PublishEventAsync(run.Id, "phase.changed", new { phase = "videogen-polling", progress = 10, jobId = submitResult.JobId });

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

            var status = await client.GetStatusAsync(appCallerCode, submitResult.JobId!, CancellationToken.None);

            if (status.IsCompleted && !string.IsNullOrWhiteSpace(status.VideoUrl))
            {
                await _db.VideoGenRuns.UpdateOneAsync(
                    x => x.Id == run.Id,
                    Builders<VideoGenRun>.Update
                        .Set(x => x.Status, VideoGenRunStatus.Completed)
                        .Set(x => x.VideoAssetUrl, status.VideoUrl)
                        .Set(x => x.DirectVideoCost, status.Cost)
                        .Set(x => x.CurrentPhase, "completed")
                        .Set(x => x.PhaseProgress, 100)
                        .Set(x => x.EndedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);

                await PublishEventAsync(run.Id, "run.completed", new
                {
                    videoUrl = status.VideoUrl,
                    cost = status.Cost
                });

                _logger.LogInformation("VideoGen 直出完成: runId={RunId}, url={Url}, cost=${Cost}",
                    run.Id, status.VideoUrl, status.Cost);
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
            await PublishEventAsync(run.Id, "phase.progress", new { phase = "videogen-polling", progress, status = status.Status });
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
}
