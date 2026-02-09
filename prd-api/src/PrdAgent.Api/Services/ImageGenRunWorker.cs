using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.MultiImage;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Api.Services;

/// <summary>
/// 生图任务后台执行器：将“批量生图”从 HTTP 连接中解耦，避免前端断线导致任务中断。
/// </summary>
public class ImageGenRunWorker : BackgroundService
{
    private readonly MongoDbContext _db;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<ImageGenRunWorker> _logger;
    private readonly IRunEventStore _runStore;
    private readonly ILLMRequestContextAccessor _llmRequestContext;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static bool IsRegisteredImageGenAppCaller(string? appCallerCode)
    {
        if (string.IsNullOrWhiteSpace(appCallerCode)) return false;
        var def = AppCallerRegistrationService.FindByAppCode(appCallerCode);
        return def != null && def.ModelTypes.Contains(ModelTypes.ImageGen);
    }

    private static string? ResolveImageGenAppCallerCode(ImageGenRun run, bool isVisionMode, int imageRefCount, bool hasInitImage)
    {
        if (string.Equals(run.AppKey, "visual-agent", StringComparison.OrdinalIgnoreCase))
        {
            if (isVisionMode && imageRefCount > 1) return AppCallerRegistry.VisualAgent.Image.VisionGen;
            if (hasInitImage || imageRefCount == 1) return AppCallerRegistry.VisualAgent.Image.Img2Img;
            return AppCallerRegistry.VisualAgent.Image.Text2Img;
        }
        if (string.Equals(run.AppKey, "literary-agent", StringComparison.OrdinalIgnoreCase))
        {
            // 根据是否有参考图选择 Text2Img 或 Img2Img
            if (hasInitImage) return AppCallerRegistry.LiteraryAgent.Illustration.Img2Img;
            return AppCallerRegistry.LiteraryAgent.Illustration.Text2Img;
        }

        return string.IsNullOrWhiteSpace(run.AppCallerCode) ? null : run.AppCallerCode;
    }

    public ImageGenRunWorker(
        MongoDbContext db,
        IServiceScopeFactory scopeFactory,
        IRunEventStore runStore,
        ILogger<ImageGenRunWorker> logger,
        ILLMRequestContextAccessor llmRequestContext)
    {
        _db = db;
        _scopeFactory = scopeFactory;
        _runStore = runStore;
        _logger = logger;
        _llmRequestContext = llmRequestContext;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // 轮询模式：队列量很小（管理员生图），优先简单可靠
        while (!stoppingToken.IsCancellationRequested)
        {
            ImageGenRun? run = null;
            try
            {
                run = await ClaimNextRunAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "ImageGenRunWorker claim failed");
            }

            if (run == null)
            {
                try
                {
                    await Task.Delay(600, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                continue;
            }

            try
            {
                await ProcessRunAsync(run, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                // app shutting down：尽量把 run 标记为失败/取消（避免永远 Running）
                await MarkRunFailedSafeAsync(run.Id, "WORKER_STOPPED", "服务正在停止", CancellationToken.None);
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "ImageGenRunWorker process failed: {RunId}", run.Id);
                await MarkRunFailedSafeAsync(run.Id, ErrorCodes.INTERNAL_ERROR, ex.Message, stoppingToken);
            }
        }
    }

    private async Task<ImageGenRun?> ClaimNextRunAsync(CancellationToken ct)
    {
        var filter = Builders<ImageGenRun>.Filter.Eq(x => x.Status, ImageGenRunStatus.Queued)
                     & Builders<ImageGenRun>.Filter.Ne(x => x.CancelRequested, true);
        var update = Builders<ImageGenRun>.Update
            .Set(x => x.Status, ImageGenRunStatus.Running)
            .Set(x => x.StartedAt, DateTime.UtcNow);

        var options = new FindOneAndUpdateOptions<ImageGenRun, ImageGenRun>
        {
            Sort = Builders<ImageGenRun>.Sort.Ascending(x => x.CreatedAt),
            ReturnDocument = ReturnDocument.After
        };

        return await _db.ImageGenRuns.FindOneAndUpdateAsync(filter, update, options, ct);
    }

    private async Task ProcessRunAsync(ImageGenRun claimed, CancellationToken ct)
    {
        // 重新读取最新 run（避免 claim 返回的字段不完整/过旧）
        var run = await _db.ImageGenRuns.Find(x => x.Id == claimed.Id).FirstOrDefaultAsync(ct);
        if (run == null) return;

        // 若 ConfigModelId 存在且 run 未填平台信息，则尝试补齐（用于事件输出与后续查询）
        if (!string.IsNullOrWhiteSpace(run.ConfigModelId) && (string.IsNullOrWhiteSpace(run.PlatformId) || string.IsNullOrWhiteSpace(run.ModelId)))
        {
            var m = await _db.LLMModels.Find(x => x.Id == run.ConfigModelId && x.Enabled).FirstOrDefaultAsync(ct);
            if (m != null)
            {
                var pid = string.IsNullOrWhiteSpace(run.PlatformId) ? m.PlatformId : run.PlatformId;
                var mid = string.IsNullOrWhiteSpace(run.ModelId) ? m.ModelName : run.ModelId;
                run.PlatformId = pid;
                run.ModelId = mid;
                await _db.ImageGenRuns.UpdateOneAsync(
                    x => x.Id == run.Id,
                    Builders<ImageGenRun>.Update.Set(x => x.PlatformId, pid).Set(x => x.ModelId, mid),
                    cancellationToken: ct);
            }
        }

        // 模型池调度：统一在 Worker 中处理，确保所有来源的 Run 都能正确关联模型池
        var preRefCount = run.ImageRefs?.Count ?? 0;
        var preHasInit = !string.IsNullOrWhiteSpace(run.InitImageAssetSha256);
        var preIsVision = preRefCount > 1;
        var preAppCallerCode = ResolveImageGenAppCallerCode(run, preIsVision, preRefCount, preHasInit);
        if (!IsRegisteredImageGenAppCaller(preAppCallerCode))
        {
            var msg = "appCallerCode 未注册或缺失，已拒绝执行生图";
            await AppendEventAsync(run, "run", new { type = "error", errorCode = ErrorCodes.INVALID_FORMAT, errorMessage = msg }, ct);
            await MarkRunFailedSafeAsync(run.Id, ErrorCodes.INVALID_FORMAT, msg, ct);
            return;
        }
        await ResolveModelGroupAsync(run, preAppCallerCode!, ct);

        var items = run.Items ?? new List<ImageGenRunPlanItem>();
        if (items.Count == 0)
        {
            await AppendEventAsync(run, "run", new { type = "error", errorCode = ErrorCodes.INVALID_FORMAT, errorMessage = "items 不能为空" }, ct);
            await MarkRunFailedSafeAsync(run.Id, ErrorCodes.INVALID_FORMAT, "items 不能为空", ct);
            return;
        }

        // 统一限制：最多 20 张
        var total = 0;
        for (var i = 0; i < items.Count; i++)
        {
            var c = items[i].Count <= 0 ? 1 : items[i].Count;
            if (c > 5) c = 5;
            total += c;
        }
        if (total > 20)
        {
            await AppendEventAsync(run, "run", new { type = "error", errorCode = ErrorCodes.RATE_LIMITED, errorMessage = $"单次最多生成 20 张（当前 {total} 张）" }, ct);
            await MarkRunFailedSafeAsync(run.Id, ErrorCodes.RATE_LIMITED, $"单次最多生成 20 张（当前 {total} 张）", ct);
            return;
        }

        // 将 total 写回 run（创建接口也会写，这里兜底）
        if (run.Total != total)
        {
            run.Total = total;
            await _db.ImageGenRuns.UpdateOneAsync(x => x.Id == run.Id, Builders<ImageGenRun>.Update.Set(x => x.Total, total), cancellationToken: ct);
        }

        await AppendEventAsync(run, "run", new
        {
            type = "runStart",
            runId = run.Id,
            total,
            modelId = run.ModelId,
            platformId = run.PlatformId,
            configModelId = run.ConfigModelId,
            size = run.Size,
            responseFormat = run.ResponseFormat
        }, ct);

        var maxConc = Math.Clamp(run.MaxConcurrency <= 0 ? 3 : run.MaxConcurrency, 1, 10);
        var sem = new SemaphoreSlim(maxConc, maxConc);
        var tasks = new List<Task>();

        using var scope = _scopeFactory.CreateScope();
        var imageClient = scope.ServiceProvider.GetRequiredService<OpenAIImageClient>();
        var assetStorage = scope.ServiceProvider.GetRequiredService<IAssetStorage>();

        for (var itemIndex = 0; itemIndex < items.Count; itemIndex++)
        {
            var prompt = (items[itemIndex].Prompt ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(prompt))
            {
                // 空 prompt：整项计为失败
                var c = Math.Max(1, Math.Min(5, items[itemIndex].Count <= 0 ? 1 : items[itemIndex].Count));
                await _db.ImageGenRuns.UpdateOneAsync(x => x.Id == run.Id, Builders<ImageGenRun>.Update.Inc(x => x.Failed, c), cancellationToken: ct);
                for (var k = 0; k < c; k++)
                {
                    var key = new { runId = run.Id, itemIndex, imageIndex = k };
                    await UpsertRunItemAsync(run, itemIndex, k, prompt: "", requestedSize: ResolveSize(run, items[itemIndex]), status: ImageGenRunItemStatus.Error, null, null, null, ErrorCodes.INVALID_FORMAT, "prompt 不能为空", ct);
                    await AppendEventAsync(run, "image", new { type = "imageError", runId = run.Id, itemIndex, imageIndex = k, prompt = "", requestedSize = ResolveSize(run, items[itemIndex]), modelId = run.ModelId, platformId = run.PlatformId, errorCode = ErrorCodes.INVALID_FORMAT, errorMessage = "prompt 不能为空" }, ct);
                }
                continue;
            }

            var count = Math.Clamp(items[itemIndex].Count <= 0 ? 1 : items[itemIndex].Count, 1, 5);
            for (var k = 0; k < count; k++)
            {
                var curItemIndex = itemIndex;
                var imageIndex = k;
                var curPrompt = prompt;
                var reqSize = ResolveSize(run, items[itemIndex]);

                tasks.Add(Task.Run(async () =>
                {
                    await sem.WaitAsync(ct);
                    try
                    {
                        // 用户取消：不再继续派发新的生成（已派发的请求尽量跑完）
                        if (await IsCancelRequestedAsync(run.Id, ct))
                        {
                            return;
                        }

                        await UpsertRunItemAsync(run, curItemIndex, imageIndex, curPrompt, reqSize, ImageGenRunItemStatus.Running, null, null, null, null, null, ct);
                        await AppendEventAsync(run, "image", new { type = "imageStart", runId = run.Id, itemIndex = curItemIndex, imageIndex, prompt = curPrompt, size = reqSize, requestedSize = reqSize, modelId = run.ModelId, platformId = run.PlatformId }, ct);

                        var requestedModelId = !string.IsNullOrWhiteSpace(run.ConfigModelId) ? run.ConfigModelId : run.ModelId;

                        // 多图处理：解析 @imgN 引用，构建增强 prompt，加载图片
                        string? initImageBase64 = null;
                        var finalPrompt = curPrompt;
                        var multiImageService = scope.ServiceProvider.GetRequiredService<IMultiImageDomainService>();

                        // 已加载的图片引用列表（用于 Vision API 多图场景）
                        var loadedImageRefs = new List<Core.Models.MultiImage.ImageRefData>();
                        var isMultiImageVisionMode = false;

                        // ========== 兼容层：统一 InitImageAssetSha256 → ImageRefs ==========
                        // 如果 ImageRefs 为空但 InitImageAssetSha256 存在，自动转换为 ImageRefs
                        // 这样后续逻辑只需处理 ImageRefs，无需分支
                        if ((run.ImageRefs == null || run.ImageRefs.Count == 0) &&
                            !string.IsNullOrWhiteSpace(run.InitImageAssetSha256))
                        {
                            var initSha = run.InitImageAssetSha256.Trim().ToLowerInvariant();
                            if (initSha.Length == 64 && Regex.IsMatch(initSha, "^[0-9a-f]{64}$"))
                            {
                                run.ImageRefs = new List<ImageRefInput>
                                {
                                    new() { RefId = 1, AssetSha256 = initSha, Label = "参考图" }
                                };
                                _logger.LogDebug("[兼容层] 已将 InitImageAssetSha256 转换为 ImageRefs[0]: sha={Sha}", initSha);
                            }
                        }

                        // 1. 统一使用 ImageRefs 处理所有图片场景
                        if (run.ImageRefs != null && run.ImageRefs.Count > 0)
                        {
                            var parseResult = multiImageService.ParsePromptRefs(curPrompt, run.ImageRefs);

                            if (parseResult.IsValid && parseResult.ResolvedRefs.Count > 0)
                            {
                                // 构建增强 prompt（包含图片对照表）
                                finalPrompt = await multiImageService.BuildFinalPromptAsync(
                                    curPrompt,
                                    parseResult.ResolvedRefs,
                                    ct);

                                _logger.LogInformation(
                                    "[多图处理] RunId={RunId}, 引用数={RefCount}, 原始Prompt=\"{Original}\", 增强Prompt=\"{Enhanced}\"",
                                    run.Id,
                                    parseResult.ResolvedRefs.Count,
                                    curPrompt.Length > 50 ? curPrompt[..50] + "..." : curPrompt,
                                    finalPrompt.Length > 100 ? finalPrompt[..100] + "..." : finalPrompt);

                                // 加载所有引用的图片
                                foreach (var resolvedRef in parseResult.ResolvedRefs.OrderBy(r => r.OccurrenceOrder))
                                {
                                    if (string.IsNullOrWhiteSpace(resolvedRef.AssetSha256)) continue;

                                    var sha = resolvedRef.AssetSha256.Trim().ToLowerInvariant();
                                    if (sha.Length != 64 || !Regex.IsMatch(sha, "^[0-9a-f]{64}$")) continue;

                                    var found = await assetStorage.TryReadByShaAsync(sha, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
                                    if (found != null && found.Value.bytes.Length > 0)
                                    {
                                        var mime = string.IsNullOrWhiteSpace(found.Value.mime) ? "image/png" : found.Value.mime.Trim();
                                        // 优先使用 COS URL（公网可访问），避免 base64 造成请求体/日志膨胀
                                        var cosUrl = assetStorage.TryBuildUrlBySha(sha, mime, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);

                                        if (!string.IsNullOrWhiteSpace(cosUrl))
                                        {
                                            loadedImageRefs.Add(new Core.Models.MultiImage.ImageRefData
                                            {
                                                RefId = resolvedRef.RefId,
                                                Base64 = cosUrl!,  // 使用 COS URL 代替 base64
                                                MimeType = mime,
                                                Label = resolvedRef.Label,
                                                Role = resolvedRef.Role,
                                                Sha256 = sha,
                                                CosUrl = cosUrl
                                            });

                                            _logger.LogDebug("[多图处理] 已加载图片 @img{RefId}: {Label} (COS URL)",
                                                resolvedRef.RefId, resolvedRef.Label);
                                        }
                                        else
                                        {
                                            // COS URL 不可用时回退到 base64
                                            var b64 = Convert.ToBase64String(found.Value.bytes);
                                            var dataUrl = $"data:{mime};base64,{b64}";

                                            loadedImageRefs.Add(new Core.Models.MultiImage.ImageRefData
                                            {
                                                RefId = resolvedRef.RefId,
                                                Base64 = dataUrl,
                                                MimeType = mime,
                                                Label = resolvedRef.Label,
                                                Role = resolvedRef.Role,
                                                Sha256 = sha,
                                                CosUrl = null
                                            });

                                            _logger.LogDebug("[多图处理] 已加载图片 @img{RefId}: {Label} ({Size} bytes, 回退base64)",
                                                resolvedRef.RefId, resolvedRef.Label, found.Value.bytes.Length);
                                        }
                                    }
                                    else
                                    {
                                        _logger.LogWarning("[多图处理] 无法加载图片 @img{RefId}: sha={Sha}", resolvedRef.RefId, sha);
                                    }
                                }

                                // 判断是否使用 Vision API（多图模式）
                                if (loadedImageRefs.Count > 1)
                                {
                                    isMultiImageVisionMode = true;
                                    _logger.LogInformation(
                                        "[多图处理] 启用 Vision API 多图模式，共 {Count} 张图片: {Refs}",
                                        loadedImageRefs.Count,
                                        string.Join(", ", loadedImageRefs.Select(r => $"@img{r.RefId}:{r.Label}")));
                                }
                                else if (loadedImageRefs.Count == 1)
                                {
                                    // 单图模式：使用传统 img2img
                                    initImageBase64 = loadedImageRefs[0].Base64;
                                    _logger.LogDebug("[多图处理] 单图模式，使用 @img{RefId} 作为参考图", loadedImageRefs[0].RefId);
                                }
                            }

                            if (parseResult.Warnings.Count > 0)
                            {
                                _logger.LogWarning("[多图处理] 解析警告: {Warnings}", string.Join("; ", parseResult.Warnings));
                            }

                            // ========== 无 @imgN 但有图片的场景 ==========
                            // 如果 ImageRefs 有图但 prompt 没有 @imgN，直接加载所有图片使用
                            // 这种场景下不做 prompt 增强（因为没有 @imgN 可以替换）
                            if (parseResult.ResolvedRefs.Count == 0 && run.ImageRefs.Count > 0)
                            {
                                _logger.LogInformation("[无@imgN场景] prompt 无 @imgN 引用，但有 {Count} 张图片，直接加载使用", run.ImageRefs.Count);

                                foreach (var imgRef in run.ImageRefs)
                                {
                                    if (string.IsNullOrWhiteSpace(imgRef.AssetSha256)) continue;

                                    var sha = imgRef.AssetSha256.Trim().ToLowerInvariant();
                                    if (sha.Length != 64 || !Regex.IsMatch(sha, "^[0-9a-f]{64}$")) continue;

                                    var found2 = await assetStorage.TryReadByShaAsync(sha, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
                                    if (found2 != null && found2.Value.bytes.Length > 0)
                                    {
                                        var mime = string.IsNullOrWhiteSpace(found2.Value.mime) ? "image/png" : found2.Value.mime.Trim();
                                        // 优先使用 COS URL
                                        var cosUrl = assetStorage.TryBuildUrlBySha(sha, mime, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
                                        string imageValue;
                                        if (!string.IsNullOrWhiteSpace(cosUrl))
                                        {
                                            imageValue = cosUrl!;
                                        }
                                        else
                                        {
                                            var b64 = Convert.ToBase64String(found2.Value.bytes);
                                            imageValue = $"data:{mime};base64,{b64}";
                                        }

                                        loadedImageRefs.Add(new Core.Models.MultiImage.ImageRefData
                                        {
                                            RefId = imgRef.RefId,
                                            Base64 = imageValue,
                                            MimeType = mime,
                                            Label = imgRef.Label ?? $"图片{imgRef.RefId}",
                                            Sha256 = sha,
                                            CosUrl = cosUrl
                                        });
                                    }
                                }

                                // 根据加载的图片数量决定模式
                                if (loadedImageRefs.Count > 1)
                                {
                                    isMultiImageVisionMode = true;
                                    _logger.LogInformation("[无@imgN场景] 启用 Vision API，共 {Count} 张图片", loadedImageRefs.Count);
                                }
                                else if (loadedImageRefs.Count == 1)
                                {
                                    initImageBase64 = loadedImageRefs[0].Base64;
                                    _logger.LogInformation("[无@imgN场景] 单图模式，使用参考图 sha={Sha}", loadedImageRefs[0].Sha256);
                                }
                            }
                        }
                        // 2. 无图片场景：text2img（兼容层已处理 InitImageAssetSha256，这里只剩真正的无图情况）
                        else
                        {
                            _logger.LogDebug("[text2img] 无参考图，使用纯文生图模式");
                        }

                        _logger.LogInformation("[ImageGenRunWorker Debug] Run {RunId}: AppKey={AppKey}, UserId={UserId}, AppCallerCode={AppCallerCode}",
                            run.Id, run.AppKey ?? "(null)", run.OwnerAdminId, run.AppCallerCode ?? "(null)");

                        // AppCallerCode：仅允许已注册的 code（禁止拼接/隐式生成）
                        var resolvedAppCallerCode = ResolveImageGenAppCallerCode(
                            run,
                            isMultiImageVisionMode,
                            loadedImageRefs.Count,
                            initImageBase64 != null);
                        if (!IsRegisteredImageGenAppCaller(resolvedAppCallerCode))
                        {
                            var msg = "appCallerCode 未注册或缺失，已拒绝执行生图";
                            await AppendEventAsync(run, "run", new { type = "error", errorCode = ErrorCodes.INVALID_FORMAT, errorMessage = msg }, ct);
                            await MarkRunFailedSafeAsync(run.Id, ErrorCodes.INVALID_FORMAT, msg, ct);
                            return;
                        }
                        var appCallerCode = resolvedAppCallerCode!;

                        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                            RequestId: $"{run.Id}-{curItemIndex}-{imageIndex}",
                            GroupId: null,
                            SessionId: null,
                            UserId: run.OwnerAdminId,
                            ViewRole: "ADMIN",
                            DocumentChars: null,
                            DocumentHash: null,
                            SystemPromptRedacted: "[IMAGE_GEN_RUN]",
                            RequestType: "imageGen",
                            RequestPurpose: appCallerCode,
                            PlatformId: run.PlatformId,
                            ModelResolutionType: run.ModelResolutionType,
                            ModelGroupId: run.ModelGroupId,
                            ModelGroupName: run.ModelGroupName));

                        _logger.LogInformation("[ImageGenRunWorker Debug] Calling GenerateAsync with appCallerCode={AppCallerCode}", appCallerCode);

                        // 调试日志：打印发送给生图模型的完整 prompt
                        _logger.LogInformation(
                            "[生图请求] RunId={RunId}\n" +
                            "  原始Prompt: {OriginalPrompt}\n" +
                            "  最终Prompt: {FinalPrompt}\n" +
                            "  有参考图: {HasInitImage}\n" +
                            "  图片引用数: {ImageRefCount}\n" +
                            "  多图Vision模式: {IsVisionMode}\n" +
                            "  已加载图片数: {LoadedCount}",
                            run.Id,
                            curPrompt,
                            finalPrompt,
                            initImageBase64 != null,
                            run.ImageRefs?.Count ?? 0,
                            isMultiImageVisionMode,
                            loadedImageRefs.Count);

                        // 统一图片生成：根据 images 数量自动路由（文生图/图生图/多图）
                        // 将所有已加载的图片（含 initImageBase64 单图兼容）合并为 data URI 列表
                        var allImages = new List<string>();
                        if (loadedImageRefs.Count > 0)
                        {
                            allImages.AddRange(loadedImageRefs.Select(r =>
                                r.Base64.StartsWith("data:", StringComparison.OrdinalIgnoreCase)
                                    ? r.Base64
                                    : $"data:{r.MimeType ?? "image/png"};base64,{r.Base64}"));
                        }
                        else if (!string.IsNullOrWhiteSpace(initImageBase64))
                        {
                            allImages.Add(initImageBase64);
                        }

                        var res = await imageClient.GenerateUnifiedAsync(
                            finalPrompt,
                            n: 1,
                            size: reqSize,
                            responseFormat: run.ResponseFormat,
                            ct,
                            appCallerCode,
                            images: allImages.Count > 0 ? allImages : null,
                            modelId: requestedModelId,
                            platformId: run.PlatformId,
                            modelName: run.ModelId,
                            maskBase64: run.MaskBase64);

                        if (!res.Success || res.Data == null)
                        {
                            var code = res.Error?.Code ?? ErrorCodes.LLM_ERROR;
                            var msg = res.Error?.Message ?? "生图失败";
                            await UpsertRunItemAsync(run, curItemIndex, imageIndex, curPrompt, reqSize, ImageGenRunItemStatus.Error, null, null, null, code, msg, ct);
                            await _db.ImageGenRuns.UpdateOneAsync(x => x.Id == run.Id, Builders<ImageGenRun>.Update.Inc(x => x.Failed, 1), cancellationToken: ct);
                            await AppendEventAsync(run, "image", new
                            {
                                type = "imageError",
                                runId = run.Id,
                                itemIndex = curItemIndex,
                                imageIndex,
                                prompt = curPrompt,
                                requestedSize = reqSize,
                                modelId = run.ModelId,
                                platformId = run.PlatformId,
                                errorCode = code,
                                errorMessage = msg
                            }, ct);

                            // 文学创作：自动回填 ArticleIllustrationMarker.Status 为 error
                            await TryPatchArticleMarkerAsync(run, "error", msg, null, ct);
                            return;
                        }

                        var first = res.Data.Images.FirstOrDefault();
                        var meta = res.Data.Meta;
                        var effSize = string.IsNullOrWhiteSpace(meta?.EffectiveSize) ? null : meta!.EffectiveSize!.Trim();
                        var base64 = first?.Base64;
                        var url = first?.Url;
                        var revisedPrompt = first?.RevisedPrompt;
                        var sizeAdjusted = meta?.SizeAdjusted ?? false;
                        var ratioAdjusted = meta?.RatioAdjusted ?? false;

                        // 从生成结果中提取原图信息（无水印版）
                        var originalUrl = first?.OriginalUrl;
                        var originalSha256 = first?.OriginalSha256;

                        // ImageMaster：若绑定 workspace，则把结果落到资产（COS）并回填画布元素（避免断线/关闭导致丢失）
                        ImageAsset? persisted = null;
                        if (!string.IsNullOrWhiteSpace(run.WorkspaceId))
                        {
                            persisted = await TryPersistToImageMasterAsync(run, curPrompt, reqSize, effSize, base64, url, originalUrl, originalSha256, assetStorage, ct);
                            if (persisted != null)
                            {
                                url = persisted.Url;
                                originalUrl = persisted.OriginalUrl;
                                originalSha256 = persisted.OriginalSha256;
                                base64 = null;
                            }
                        }

                        await UpsertRunItemAsync(run, curItemIndex, imageIndex, curPrompt, reqSize, ImageGenRunItemStatus.Done, base64, url, revisedPrompt, null, null, ct, effSize, sizeAdjusted, ratioAdjusted);
                        await _db.ImageGenRuns.UpdateOneAsync(x => x.Id == run.Id, Builders<ImageGenRun>.Update.Inc(x => x.Done, 1), cancellationToken: ct);
                        await AppendEventAsync(run, "image", new
                        {
                            type = "imageDone",
                            runId = run.Id,
                            itemIndex = curItemIndex,
                            imageIndex,
                            prompt = curPrompt,
                            requestedSize = reqSize,
                            effectiveSize = effSize,
                            sizeAdjusted,
                            ratioAdjusted,
                            modelId = run.ModelId,
                            platformId = run.PlatformId,
                            base64,
                            url,
                            originalUrl,
                            originalSha256,
                            revisedPrompt,
                            asset = persisted == null ? null : new
                            {
                                id = persisted.Id,
                                sha256 = persisted.Sha256,
                                url = persisted.Url,
                                originalUrl = persisted.OriginalUrl,
                                originalSha256 = persisted.OriginalSha256
                            }
                        }, ct);

                        // 文学创作：自动回填 ArticleIllustrationMarker.Status 为 done
                        await TryPatchArticleMarkerAsync(run, "done", null, url ?? persisted?.Url, ct);
                    }
                    finally
                    {
                        sem.Release();
                    }
                }, ct));
            }
        }

        try
        {
            await Task.WhenAll(tasks);
        }
        catch (OperationCanceledException)
        {
            // ignore：worker stop
        }

        var final = await _db.ImageGenRuns.Find(x => x.Id == run.Id).FirstOrDefaultAsync(ct);
        if (final == null) return;

        var cancel = final.CancelRequested;
        var nextStatus = cancel
            ? ImageGenRunStatus.Cancelled
            : (final.Failed > 0 ? ImageGenRunStatus.Failed : ImageGenRunStatus.Completed);

        await _db.ImageGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<ImageGenRun>.Update.Set(x => x.Status, nextStatus).Set(x => x.EndedAt, DateTime.UtcNow),
            cancellationToken: ct);

        await AppendEventAsync(run, "run", new
        {
            type = "runDone",
            runId = run.Id,
            total = final.Total,
            done = final.Done,
            failed = final.Failed,
            status = nextStatus.ToString(),
            endedAt = DateTime.UtcNow
        }, ct);
    }

    private static string ResolveSize(ImageGenRun run, ImageGenRunPlanItem planItem)
    {
        var s = (planItem.Size ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(s)) return s;
        s = (run.Size ?? string.Empty).Trim();
        return string.IsNullOrWhiteSpace(s) ? "1024x1024" : s;
    }

    private async Task<bool> IsCancelRequestedAsync(string runId, CancellationToken ct)
    {
        var cur = await _db.ImageGenRuns
            .Find(x => x.Id == runId)
            .Project(x => new { x.CancelRequested })
            .FirstOrDefaultAsync(ct);
        return cur?.CancelRequested == true;
    }

    private async Task AppendEventAsync(ImageGenRun run, string eventName, object payload, CancellationToken ct)
    {
        // 高频事件：写入 RunStore（Redis），避免每个 delta 都更新 Mongo 的 LastSeq / events
        _ = await _runStore.AppendEventAsync(RunKinds.ImageGen, run.Id, eventName, payload, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
    }

    private async Task UpsertRunItemAsync(
        ImageGenRun run,
        int itemIndex,
        int imageIndex,
        string prompt,
        string requestedSize,
        ImageGenRunItemStatus status,
        string? base64,
        string? url,
        string? revisedPrompt,
        string? errorCode,
        string? errorMessage,
        CancellationToken ct,
        string? effectiveSize = null,
        bool? sizeAdjusted = null,
        bool? ratioAdjusted = null)
    {
        var now = DateTime.UtcNow;
        // 不依赖 unique 索引：以确定性 Id 防并发重复插入（仅依赖 _id 唯一）
        var fixedId = $"{run.Id}:{itemIndex}:{imageIndex}";
        var filter = Builders<ImageGenRunItem>.Filter.Eq(x => x.Id, fixedId);

        var update = Builders<ImageGenRunItem>.Update
            .SetOnInsert(x => x.Id, fixedId)
            .SetOnInsert(x => x.OwnerAdminId, run.OwnerAdminId)
            .SetOnInsert(x => x.RunId, run.Id)
            .SetOnInsert(x => x.ItemIndex, itemIndex)
            .SetOnInsert(x => x.ImageIndex, imageIndex)
            .SetOnInsert(x => x.CreatedAt, now)
            .Set(x => x.Prompt, prompt ?? string.Empty)
            .Set(x => x.RequestedSize, requestedSize)
            .Set(x => x.Status, status);

        if (status == ImageGenRunItemStatus.Running)
        {
            update = update.Set(x => x.StartedAt, now);
        }
        if (status is ImageGenRunItemStatus.Done or ImageGenRunItemStatus.Error)
        {
            update = update.Set(x => x.EndedAt, now);
        }

        if (effectiveSize != null) update = update.Set(x => x.EffectiveSize, effectiveSize);
        if (sizeAdjusted.HasValue) update = update.Set(x => x.SizeAdjusted, sizeAdjusted.Value);
        if (ratioAdjusted.HasValue) update = update.Set(x => x.RatioAdjusted, ratioAdjusted.Value);

        if (base64 != null) update = update.Set(x => x.Base64, base64);
        if (url != null) update = update.Set(x => x.Url, url);
        if (revisedPrompt != null) update = update.Set(x => x.RevisedPrompt, revisedPrompt);

        if (errorCode != null) update = update.Set(x => x.ErrorCode, errorCode);
        if (errorMessage != null) update = update.Set(x => x.ErrorMessage, errorMessage);

        await _db.ImageGenRunItems.UpdateOneAsync(filter, update, new UpdateOptions { IsUpsert = true }, ct);
    }

    private async Task MarkRunFailedSafeAsync(string runId, string errorCode, string errorMessage, CancellationToken ct)
    {
        try
        {
            await _db.ImageGenRuns.UpdateOneAsync(
                x => x.Id == runId,
                Builders<ImageGenRun>.Update
                    .Set(x => x.Status, ImageGenRunStatus.Failed)
                    .Set(x => x.EndedAt, DateTime.UtcNow),
                cancellationToken: ct);

            var run = await _db.ImageGenRuns.Find(x => x.Id == runId).FirstOrDefaultAsync(ct);
            if (run != null)
            {
                await AppendEventAsync(run, "run", new { type = "error", runId, errorCode, errorMessage }, ct);
                await AppendEventAsync(run, "run", new { type = "runDone", runId, status = ImageGenRunStatus.Failed.ToString(), endedAt = DateTime.UtcNow }, ct);
            }
        }
        catch
        {
            // ignore
        }
    }

    private static bool TryParseWxH(string? raw, out int w, out int h)
    {
        w = 0;
        h = 0;
        var s = (raw ?? string.Empty).Trim().ToLowerInvariant();
        var m = Regex.Match(s, "^(\\d{2,5})x(\\d{2,5})$");
        if (!m.Success) return false;
        if (!int.TryParse(m.Groups[1].Value, out w)) return false;
        if (!int.TryParse(m.Groups[2].Value, out h)) return false;
        if (w <= 0 || h <= 0) return false;
        return true;
    }

    private async Task<ImageAsset?> TryPersistToImageMasterAsync(
        ImageGenRun run,
        string prompt,
        string requestedSize,
        string? effectiveSize,
        string? base64,
        string? url,
        string? originalUrl,
        string? originalSha256,
        IAssetStorage assetStorage,
        CancellationToken ct)
    {
        var wid = (run.WorkspaceId ?? string.Empty).Trim();
        var adminId = (run.OwnerAdminId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid) || string.IsNullOrWhiteSpace(adminId)) return null;

        // 原图已在 OpenAIImageClient 保存到 imagemaster 目录
        // 这里只需创建 ImageAsset 记录，不需要重新下载保存
        // 如果没有 originalUrl/originalSha256，则回退到下载 url

        string assetUrl;
        string assetSha256;
        string assetMime = "image/png";
        long assetSizeBytes = 0;

        if (!string.IsNullOrWhiteSpace(originalUrl) && !string.IsNullOrWhiteSpace(originalSha256))
        {
            // 已有原图信息，直接使用
            assetUrl = originalUrl.Trim();
            assetSha256 = originalSha256.Trim();
        }
        else
        {
            // 回退：下载展示图保存（兼容旧逻辑）
            byte[]? bytes = null;
            if (!string.IsNullOrWhiteSpace(url) && Uri.TryCreate(url.Trim(), UriKind.Absolute, out var u))
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
                using var resp = await http.GetAsync(u, ct).ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode) return null;
                assetMime = resp.Content.Headers.ContentType?.MediaType ?? "image/png";
                bytes = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
            }
            if (bytes == null || bytes.Length == 0) return null;
            if (bytes.LongLength > 15 * 1024 * 1024) return null;
            if (!assetMime.StartsWith("image/", StringComparison.OrdinalIgnoreCase)) assetMime = "image/png";

            var stored = await assetStorage.SaveAsync(bytes, assetMime, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
            assetUrl = stored.Url;
            assetSha256 = stored.Sha256;
            assetSizeBytes = stored.SizeBytes;
        }

        // 创建 ImageAsset 记录
        // Sha256 = 原图 SHA256（用于参考图查找）
        // Url = 展示图 URL（可能是水印图）
        var asset = new ImageAsset
        {
            Id = Guid.NewGuid().ToString("N"),
            OwnerUserId = adminId,
            WorkspaceId = wid,
            Sha256 = assetSha256,
            Mime = assetMime,
            SizeBytes = assetSizeBytes,
            Url = url ?? assetUrl,  // 展示用（有水印时是 watermark URL，无水印时是 imagemaster URL）
            Prompt = (prompt ?? string.Empty).Trim(),
            CreatedAt = DateTime.UtcNow,
            OriginalUrl = assetUrl,
            OriginalSha256 = assetSha256
        };
        if (asset.Prompt != null && asset.Prompt.Length > 300) asset.Prompt = asset.Prompt[..300].Trim();

        var sizeForMeta = string.IsNullOrWhiteSpace(effectiveSize) ? requestedSize : effectiveSize!;
        if (TryParseWxH(sizeForMeta, out var w, out var h))
        {
            asset.Width = w;
            asset.Height = h;
        }

        await _db.ImageAssets.InsertOneAsync(asset, cancellationToken: ct);

        await TryPatchWorkspaceCanvasAsync(run, asset, ct);
        return asset;
    }

    private async Task TryPatchWorkspaceCanvasAsync(ImageGenRun run, ImageAsset asset, CancellationToken ct)
    {
        var wid = (run.WorkspaceId ?? string.Empty).Trim();
        var key = (run.TargetCanvasKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid) || string.IsNullOrWhiteSpace(key)) return;

        for (var attempt = 0; attempt < 5; attempt++)
        {
            var canvas = await _db.ImageMasterCanvases.Find(x => x.WorkspaceId == wid).FirstOrDefaultAsync(ct);
            if (canvas == null) return;
            var raw = (canvas.PayloadJson ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(raw)) return;

            JsonNode? root;
            try { root = JsonNode.Parse(raw); } catch { return; }
            if (root == null) return;

            var elements = root["elements"] as JsonArray;
            if (elements == null) return;

            JsonObject? target = null;
            foreach (var n in elements)
            {
                var o = n as JsonObject;
                if (o == null) continue;
                // 前端保存时使用 "id" 字段，这里也用 "id" 查找（兼容 "key" 字段以防旧数据）
                var k = (o["id"]?.GetValue<string>() ?? o["key"]?.GetValue<string>() ?? string.Empty).Trim();
                if (string.Equals(k, key, StringComparison.Ordinal))
                {
                    target = o;
                    break;
                }
            }

            if (target == null)
            {
                var o = new JsonObject
                {
                    ["id"] = key, // 使用 id 字段，与前端保持一致
                    ["kind"] = "image",
                    ["status"] = "done",
                    ["syncStatus"] = "synced",
                    ["prompt"] = asset.Prompt ?? "",
                    ["src"] = asset.Url ?? "",
                    ["assetId"] = asset.Id,
                    ["sha256"] = asset.Sha256,
                    ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                };
                if (run.TargetX.HasValue) o["x"] = run.TargetX.Value;
                if (run.TargetY.HasValue) o["y"] = run.TargetY.Value;
                if (run.TargetW.HasValue) o["w"] = run.TargetW.Value;
                if (run.TargetH.HasValue) o["h"] = run.TargetH.Value;
                elements.Add(o);
            }
            else
            {
                target["kind"] = "image";
                target["status"] = "done";
                target["syncStatus"] = "synced";
                target["syncError"] = null;
                target["src"] = asset.Url ?? "";
                target["assetId"] = asset.Id;
                target["sha256"] = asset.Sha256;
                if (!string.IsNullOrWhiteSpace(asset.Prompt)) target["prompt"] = asset.Prompt!;
            }

            var nextJson = root.ToJsonString(new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            var now = DateTime.UtcNow;
            var res = await _db.ImageMasterCanvases.UpdateOneAsync(
                x => x.Id == canvas.Id && x.UpdatedAt == canvas.UpdatedAt,
                Builders<ImageMasterCanvas>.Update.Set(x => x.PayloadJson, nextJson).Set(x => x.UpdatedAt, now),
                cancellationToken: ct);
            if (res.ModifiedCount > 0) return;
        }
    }

    /// <summary>
    /// 文学创作场景：自动回填 ArticleIllustrationMarker 的状态。
    /// 当 run.ArticleMarkerIndex 有值时，更新对应 marker 的 status/errorMessage/url。
    /// </summary>
    private async Task TryPatchArticleMarkerAsync(
        ImageGenRun run,
        string status,
        string? errorMessage,
        string? url,
        CancellationToken ct)
    {
        // 只有文学创作场景（有 ArticleMarkerIndex）才需要回填
        if (!run.ArticleMarkerIndex.HasValue) return;
        var wid = (run.WorkspaceId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return;

        var markerIndex = run.ArticleMarkerIndex.Value;

        for (var attempt = 0; attempt < 5; attempt++)
        {
            var ws = await _db.ImageMasterWorkspaces.Find(x => x.Id == wid).FirstOrDefaultAsync(ct);
            if (ws == null) return;

            var wf = ws.ArticleWorkflow;
            if (wf == null || wf.Markers == null || markerIndex < 0 || markerIndex >= wf.Markers.Count) return;

            var marker = wf.Markers[markerIndex];
            marker.Status = status;
            marker.UpdatedAt = DateTime.UtcNow;

            if (!string.IsNullOrWhiteSpace(errorMessage))
            {
                marker.ErrorMessage = errorMessage;
            }
            else if (status == "done")
            {
                marker.ErrorMessage = null; // 清空错误信息
            }

            if (!string.IsNullOrWhiteSpace(url))
            {
                marker.Url = url;
            }

            var res = await _db.ImageMasterWorkspaces.UpdateOneAsync(
                x => x.Id == wid && x.UpdatedAt == ws.UpdatedAt,
                Builders<ImageMasterWorkspace>.Update
                    .Set(x => x.ArticleWorkflow, wf)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);

            if (res.ModifiedCount > 0)
            {
                _logger.LogInformation(
                    "[文学创作] Marker 状态自动回填: WorkspaceId={WorkspaceId}, MarkerIndex={MarkerIndex}, Status={Status}",
                    wid, markerIndex, status);
                return;
            }

            // 乐观锁冲突，重试
            await Task.Delay(50, ct);
        }

        _logger.LogWarning(
            "[文学创作] Marker 状态回填失败（乐观锁冲突次数过多）: WorkspaceId={WorkspaceId}, MarkerIndex={MarkerIndex}",
            wid, markerIndex);
    }

    /// <summary>
    /// 模型池调度：统一在 Worker 中处理，确保所有来源的 Run 都能正确关联模型池
    /// 仅通过 AppCaller 绑定关系查询模型池，不进行 platformId+modelId 反查
    /// </summary>
    private async Task ResolveModelGroupAsync(ImageGenRun run, string appCallerCode, CancellationToken ct)
    {
        // 保存前端期望的模型信息（用于日志对比）
        var frontendExpectedPlatformId = run.PlatformId;
        var frontendExpectedModelId = run.ModelId;
        var frontendExpectedConfigModelId = run.ConfigModelId;
        
        // 详细日志：记录输入参数（包含图片引用数量）
        var firstPrompt = run.Items?.FirstOrDefault()?.Prompt ?? "";
        var promptPreview = firstPrompt.Length > 30 ? firstPrompt.Substring(0, 30) + "..." : firstPrompt;
        var imageRefCount = run.ImageRefs?.Count ?? 0;
        var hasInitImage = !string.IsNullOrWhiteSpace(run.InitImageAssetSha256);

        _logger.LogInformation(
            "[生图模型匹配] ====== 开始 ======\n" +
            "  RunId: {RunId}\n" +
            "  AppKey: {AppKey}\n" +
            "  ImageRefs数量: {ImageRefCount}\n" +
            "  HasInitImage: {HasInitImage}\n" +
            "  前端期望ModelId: {ExpectedModelId}\n" +
            "  前端期望PlatformId: {ExpectedPlatformId}\n" +
            "  前端ConfigModelId: {ConfigModelId}\n" +
            "  Prompt: \"{Prompt}\"",
            run.Id, run.AppKey ?? "(null)", imageRefCount, hasInitImage,
            frontendExpectedModelId ?? "(null)", frontendExpectedPlatformId ?? "(null)",
            frontendExpectedConfigModelId ?? "(null)", promptPreview);

        // 如果已经有模型解析类型信息，跳过
        if (run.ModelResolutionType.HasValue)
        {
            _logger.LogInformation(
                "[视觉创作-专属模型匹配] 跳过匹配（已有解析信息）: resolutionType={ResolutionType}, 使用模型={ModelId}", 
                run.ModelResolutionType, run.ModelId ?? "(null)");
            return;
        }

        ModelResolutionType resolutionType = ModelResolutionType.DirectModel; // 默认为直连单模型
        string? modelGroupId = null;
        string? modelGroupName = null;
        string? resolvedPlatformId = null;
        string? resolvedModelId = null;

        try
        {
            using var scope = _scopeFactory.CreateScope();
            var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();

            // 查询 AppCaller 绑定的模型池（简化日志）
            var appCaller = await _db.LLMAppCallers.Find(a => a.AppCode == appCallerCode).FirstOrDefaultAsync(ct);
            var requirement = appCaller?.ModelRequirements.FirstOrDefault(r => r.ModelType == "generation");

            // 获取所有绑定的模型池 code 列表
            var boundPoolCodes = new List<string>();
            if (requirement?.ModelGroupIds != null && requirement.ModelGroupIds.Count > 0)
            {
                foreach (var gid in requirement.ModelGroupIds)
                {
                    var grp = await _db.ModelGroups.Find(g => g.Id == gid).FirstOrDefaultAsync(ct);
                    if (grp != null) boundPoolCodes.Add(grp.Code ?? grp.Name);
                }
            }

            _logger.LogInformation(
                "[生图模型匹配] 可选模型池({Count}个): [{PoolCodes}]",
                boundPoolCodes.Count, string.Join(", ", boundPoolCodes));

            // 传递用户期望的模型池 code
            var expectedModelCode = frontendExpectedModelId;
            var resolved = await gateway.ResolveModelAsync(appCallerCode, "generation", expectedModelCode, ct);

            if (resolved != null)
            {
                if (Enum.TryParse<ModelResolutionType>(resolved.ResolutionType, out var parsedType))
                {
                    resolutionType = parsedType;
                }
                modelGroupId = resolved.ModelGroupId;
                modelGroupName = resolved.ModelGroupName;
                resolvedPlatformId = resolved.ActualPlatformId;
                resolvedModelId = resolved.ActualModel;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[视觉创作-专属模型匹配] 通过 AppCaller 获取模型池失败: appCallerCode={AppCallerCode}，将使用前端指定的模型", appCallerCode);
        }

        // 最终结果
        var hasSchedulerResult = !string.IsNullOrWhiteSpace(resolvedPlatformId) && !string.IsNullOrWhiteSpace(resolvedModelId);
        var finalPlatformId = hasSchedulerResult ? resolvedPlatformId : run.PlatformId;
        var finalModelId = hasSchedulerResult ? resolvedModelId : run.ModelId;
        
        // 检查模型池是否匹配成功
        var isPoolMatched = !string.IsNullOrWhiteSpace(frontendExpectedModelId) 
            && (string.Equals(frontendExpectedModelId, modelGroupName, StringComparison.OrdinalIgnoreCase)
                || string.IsNullOrWhiteSpace(modelGroupName));
        
        // 详细日志：显示完整的匹配结果
        _logger.LogInformation(
            "[生图模型匹配] ====== 完成 ======\n" +
            "  AppCallerCode (用于匹配): {AppCallerCode}\n" +
            "  ResolutionType: {ResolutionType}\n" +
            "  匹配到的模型池ID: {ModelGroupId}\n" +
            "  匹配到的模型池名称: {ModelGroupName}\n" +
            "  最终PlatformId: {FinalPlatformId}\n" +
            "  最终ModelId: {FinalModelId}\n" +
            "  调度器返回结果: {HasResult}\n" +
            "  期望vs实际: {Expected} -> {Actual}",
            appCallerCode ?? "(null)",
            resolutionType,
            modelGroupId ?? "(无)",
            modelGroupName ?? "(无)",
            finalPlatformId ?? "(null)",
            finalModelId ?? "(null)",
            hasSchedulerResult ? "是" : "否",
            frontendExpectedModelId ?? "(随机)",
            modelGroupName ?? "(使用前端指定)");

        // 更新 Run 对象和数据库
        var updateDef = Builders<ImageGenRun>.Update
            .Set(x => x.ModelResolutionType, resolutionType)
            .Set(x => x.ModelGroupId, modelGroupId)
            .Set(x => x.ModelGroupName, modelGroupName);

        // 如果通过模型池调度获取了结果，使用调度结果更新 Run
        if (hasSchedulerResult)
        {
            updateDef = updateDef
                .Set(x => x.PlatformId, resolvedPlatformId)
                .Set(x => x.ModelId, resolvedModelId)
                .Set(x => x.ConfigModelId, null); // 清空，避免后续再次查询
            run.PlatformId = resolvedPlatformId;
            run.ModelId = resolvedModelId;
            run.ConfigModelId = null;
        }

        run.ModelResolutionType = resolutionType;
        run.ModelGroupId = modelGroupId;
        run.ModelGroupName = modelGroupName;

        await _db.ImageGenRuns.UpdateOneAsync(x => x.Id == run.Id, updateDef, cancellationToken: ct);
    }
}

