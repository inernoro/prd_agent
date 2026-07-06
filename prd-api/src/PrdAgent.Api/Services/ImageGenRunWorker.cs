using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.MultiImage;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;
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
    private readonly IConfiguration _config;

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
        ILLMRequestContextAccessor llmRequestContext,
        IConfiguration config)
    {
        _db = db;
        _scopeFactory = scopeFactory;
        _runStore = runStore;
        _logger = logger;
        _llmRequestContext = llmRequestContext;
        _config = config;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // 并发处理多个 run：每个 run 的单张生图最长可挂起到 600s（LLM:ImageGenTimeoutSeconds）。
        // 若串行处理，单个被某平台拖住的 run 会卡住整个队列，造成“一个生图接口超时 → 后面所有
        // 生图都跟着超时”。这里以有界并发认领并处理，单个慢 run 不再饿死其它 run。
        var maxParallelRuns = Math.Clamp(_config.GetValue<int?>("LLM:ImageGenMaxParallelRuns") ?? 4, 1, 16);
        var inFlight = new List<Task>();

        while (!stoppingToken.IsCancellationRequested)
        {
            // 回收已完成的任务槽
            inFlight.RemoveAll(t => t.IsCompleted);

            // 槽位已满：等任一 run 结束再继续认领
            if (inFlight.Count >= maxParallelRuns)
            {
                try { await Task.WhenAny(inFlight); }
                catch { /* 单 run 异常已在 ProcessRunSafeAsync 内吞掉 */ }
                continue;
            }

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
                // 无新任务：有在跑的就等其一结束或短暂轮询，否则纯轮询
                try
                {
                    if (inFlight.Count > 0)
                        await Task.WhenAny(Task.WhenAny(inFlight), Task.Delay(600, stoppingToken));
                    else
                        await Task.Delay(600, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                continue;
            }

            inFlight.Add(ProcessRunSafeAsync(run, stoppingToken));
        }

        // 优雅停机：尽量等待在跑的 run 结束（其内部对取消会把 run 标记失败）
        try { await Task.WhenAll(inFlight); }
        catch { /* ignore */ }
    }

    /// <summary>
    /// 单个 run 的处理包装：吞掉所有异常并把 run 安全标记为失败，
    /// 保证返回的 Task 永不 fault（供 ExecuteAsync 的 WhenAny/WhenAll 安全等待）。
    /// </summary>
    private async Task ProcessRunSafeAsync(ImageGenRun run, CancellationToken stoppingToken)
    {
        try
        {
            await ProcessRunAsync(run, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // app shutting down：尽量把 run 标记为失败/取消（避免永远 Running）
            await MarkRunFailedSafeAsync(run.Id, "WORKER_STOPPED", "服务正在停止", CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ImageGenRunWorker process failed: {RunId}", run.Id);
            await MarkRunFailedSafeAsync(run.Id, ErrorCodes.INTERNAL_ERROR, ex.Message, CancellationToken.None);
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

        // 推送实际使用的模型信息（前端用此覆盖原本"前端选中的模型"展示）
        var startAdapter = ImageGenModelAdapterRegistry.TryMatch(run.ModelId);
        await AppendEventAsync(run, "run", new
        {
            type = "runStart",
            runId = run.Id,
            total,
            modelId = run.ModelId,
            platformId = run.PlatformId,
            configModelId = run.ConfigModelId,
            modelGroupName = run.ModelGroupName,
            modelGroupId = run.ModelGroupId,
            resolutionType = run.ModelResolutionType?.ToString(),
            isAdaptive = startAdapter?.SizeConstraintType == SizeConstraintTypes.Adaptive,
            adapterDisplayName = startAdapter?.DisplayName,
            size = run.Size,
            responseFormat = run.ResponseFormat
        }, ct);

        var maxConc = Math.Clamp(run.MaxConcurrency <= 0 ? 3 : run.MaxConcurrency, 1, 10);
        var sem = new SemaphoreSlim(maxConc, maxConc);
        var tasks = new List<Task>();

        using var scope = _scopeFactory.CreateScope();
        var imageClient = scope.ServiceProvider.GetRequiredService<IImageGenerationClient>();
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
            // 用户可见的 prompt（不含系统前缀/风格提示词），用于消息记录和重试
            var displayPrompt = items[itemIndex].DisplayPrompt?.Trim();
            for (var k = 0; k < count; k++)
            {
                var curItemIndex = itemIndex;
                var imageIndex = k;
                var curPrompt = prompt;
                var curDisplayPrompt = displayPrompt;
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
                                        var b64 = Convert.ToBase64String(found.Value.bytes);
                                        var dataUrl = $"data:{mime};base64,{b64}";
                                        // 构建 COS URL 用于日志显示参考图
                                        var cosUrl = assetStorage.TryBuildUrlBySha(sha, mime, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);

                                        loadedImageRefs.Add(new Core.Models.MultiImage.ImageRefData
                                        {
                                            RefId = resolvedRef.RefId,
                                            Base64 = dataUrl,
                                            MimeType = mime,
                                            Label = resolvedRef.Label,
                                            Role = resolvedRef.Role,
                                            Sha256 = sha,
                                            CosUrl = cosUrl
                                        });

                                        _logger.LogDebug("[多图处理] 已加载图片 @img{RefId}: {Label} ({Size} bytes)",
                                            resolvedRef.RefId, resolvedRef.Label, found.Value.bytes.Length);
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

                                    var found = await assetStorage.TryReadByShaAsync(sha, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
                                    if (found != null && found.Value.bytes.Length > 0)
                                    {
                                        var mime = string.IsNullOrWhiteSpace(found.Value.mime) ? "image/png" : found.Value.mime.Trim();
                                        var b64 = Convert.ToBase64String(found.Value.bytes);
                                        var dataUrl = $"data:{mime};base64,{b64}";
                                        var cosUrl = assetStorage.TryBuildUrlBySha(sha, mime, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);

                                        loadedImageRefs.Add(new Core.Models.MultiImage.ImageRefData
                                        {
                                            RefId = imgRef.RefId,
                                            Base64 = dataUrl,
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

                        // ========== 守卫：检查 prompt 中是否有未解析的 @imgN 引用 ==========
                        // 如果 finalPrompt 仍包含 @imgN 但没有加载到对应图片，说明图片引用未能解析
                        // 此时不应静默退化为 text2img（会把 "@img5@img1结合这两个" 原样发给文生图 API）
                        var unresolvedImgRefs = Regex.Matches(finalPrompt, @"@img\d+");
                        if (unresolvedImgRefs.Count > 0 && loadedImageRefs.Count == 0 && initImageBase64 == null)
                        {
                            var unresolvedTags = string.Join(", ", unresolvedImgRefs.Select(m => m.Value).Distinct());
                            _logger.LogWarning(
                                "[ImageGenRunWorker] prompt 包含未解析的图片引用 {Tags}，但无可用图片数据。RunId={RunId}, ImageRefsCount={RefsCount}",
                                unresolvedTags, run.Id, run.ImageRefs?.Count ?? 0);

                            var guardMsg = $"图片引用 {unresolvedTags} 无法解析：参考图数据缺失或已过期，请重新选择图片后再试";
                            await UpsertRunItemAsync(run, curItemIndex, imageIndex, curPrompt, reqSize, ImageGenRunItemStatus.Error, null, null, null, "IMAGE_REF_UNRESOLVED", guardMsg, ct);
                            await _db.ImageGenRuns.UpdateOneAsync(x => x.Id == run.Id, Builders<ImageGenRun>.Update.Inc(x => x.Failed, 1), cancellationToken: ct);

                            var guardGenType = "unresolved";
                            var guardPayload = JsonSerializer.Serialize(new { msg = guardMsg, prompt = curDisplayPrompt ?? StripImageGenPrefix(curPrompt), runId = run.Id, modelPool = run.ModelGroupName, genType = guardGenType }, JsonOptions);
                            var errMsgContent = $"[GEN_ERROR]{guardPayload}";
                            var errMsgId = await SaveWorkspaceMessageAsync(run.WorkspaceId ?? string.Empty, run.OwnerAdminId, "Assistant", errMsgContent, ct);

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
                                errorCode = "IMAGE_REF_UNRESOLVED",
                                errorMessage = guardMsg,
                                savedMessageId = errMsgId
                            }, ct);
                            return;
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
                            AppCallerCode: appCallerCode,
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

                        // 文学创作场景：追加中文语言约束，防止生图模型将内容翻译为英文
                        if (string.Equals(run.AppKey, "literary-agent", StringComparison.OrdinalIgnoreCase)
                            && finalPrompt.Any(c => c >= 0x4E00 && c <= 0x9FFF))
                        {
                            finalPrompt += "\n\nIMPORTANT: All text, labels, titles, and captions rendered within the image MUST be in Chinese (简体中文). Do NOT use English text anywhere in the image.";
                        }

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

                            // 服务器权威性：后端自动保存错误消息
                            var errRefSrc = loadedImageRefs.FirstOrDefault()?.CosUrl;
                            var errImageRefShas = loadedImageRefs.Count > 0 ? loadedImageRefs.Select(r => r.Sha256).Where(s => !string.IsNullOrEmpty(s)).ToList() : null;
                            var errGenType = loadedImageRefs.Count > 1 ? "vision" : (loadedImageRefs.Count == 1 ? "img2img" : "text2img");
                            var errMsgContent = $"[GEN_ERROR]{JsonSerializer.Serialize(new { msg, refSrc = errRefSrc, prompt = curDisplayPrompt ?? StripImageGenPrefix(curPrompt), runId = run.Id, modelPool = run.ModelGroupName, genType = errGenType, imageRefShas = errImageRefShas }, JsonOptions)}";

                            // 失败时也记录 input images（方便日志排查参考图问题）
                            await PatchLogImagesAsync(run, curItemIndex, imageIndex, loadedImageRefs, null, ct);
                            var errMsgId = await SaveWorkspaceMessageAsync(run.WorkspaceId ?? string.Empty, run.OwnerAdminId, "Assistant", errMsgContent, ct);

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
                                errorMessage = msg,
                                savedMessageId = errMsgId
                            }, ct);

                            // 文学创作：自动回填 ArticleIllustrationMarker.Status 为 error
                            await TryPatchArticleMarkerAsync(run, "error", msg, null, null, ct);
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
                        // 服务器权威性：后端自动保存 Assistant 消息到 image_master_messages
                        var doneRefSrc = loadedImageRefs.FirstOrDefault()?.CosUrl;
                        var doneImageRefShas = loadedImageRefs.Count > 0 ? loadedImageRefs.Select(r => r.Sha256).Where(s => !string.IsNullOrEmpty(s)).ToList() : null;
                        var doneGenType = loadedImageRefs.Count > 1 ? "vision" : (loadedImageRefs.Count == 1 ? "img2img" : "text2img");
                        var doneAdapter = ImageGenModelAdapterRegistry.TryMatch(run.ModelId);
                        var doneIsAdaptive = doneAdapter?.SizeConstraintType == SizeConstraintTypes.Adaptive;
                        // 持久化的 GEN_DONE 必须带上实际模型 / 真实出图尺寸 / 自适应标记，
                        // 否则刷新后从 DB 重放时这些字段丢失，徽标会回退到"请求尺寸 + 池名"而显示错误。
                        var doneMsgContent = $"[GEN_DONE]{JsonSerializer.Serialize(new { src = url ?? string.Empty, refSrc = doneRefSrc, prompt = curDisplayPrompt ?? StripImageGenPrefix(curPrompt), runId = run.Id, modelPool = run.ModelGroupName, actualModel = run.ModelId, actualModelPool = run.ModelGroupName, effectiveSize = effSize, isAdaptive = doneIsAdaptive, genType = doneGenType, imageRefShas = doneImageRefShas }, JsonOptions)}";
                        var doneMsgId = await SaveWorkspaceMessageAsync(run.WorkspaceId ?? string.Empty, run.OwnerAdminId, "Assistant", doneMsgContent, ct);

                        // ===== 日志图片填充：input 来自前端 COS URL，output 来自生成结果 =====
                        await PatchLogImagesAsync(run, curItemIndex, imageIndex, loadedImageRefs, res.Data.Images, ct);

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
                            modelGroupName = run.ModelGroupName,
                            isAdaptive = doneAdapter?.SizeConstraintType == SizeConstraintTypes.Adaptive,
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
                            },
                            savedMessageId = doneMsgId
                        }, ct);

                        // 文学创作：自动回填 ArticleIllustrationMarker.Status 为 done（含资产指针，最新成功优先）
                        await TryPatchArticleMarkerAsync(run, "done", null, url ?? persisted?.Url, persisted?.Id, ct);
                        await TryPatchWeeklyPosterPageAsync(run, curItemIndex, url ?? persisted?.Url, ct);
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

        // 兜底：失败/取消时把对应画布占位从 running 翻成 error（成功路径已由 TryPatchWorkspaceCanvasAsync 回填）。
        // 否则后端失败但画布元素永远停在 running，前端"预计 1024×1024"占位永久转圈，且看门狗/对账之外没有第二道闸。
        if (nextStatus is ImageGenRunStatus.Failed or ImageGenRunStatus.Cancelled
            && !string.IsNullOrWhiteSpace(run.WorkspaceId)
            && !string.IsNullOrWhiteSpace(run.TargetCanvasKey))
        {
            var errItem = await _db.ImageGenRunItems
                .Find(x => x.RunId == run.Id && x.ErrorMessage != null && x.ErrorMessage != "")
                .FirstOrDefaultAsync(ct);
            var errMsg = nextStatus == ImageGenRunStatus.Cancelled
                ? "已取消"
                : (string.IsNullOrWhiteSpace(errItem?.ErrorMessage) ? "生成失败" : errItem!.ErrorMessage!);
            await TryMarkWorkspaceCanvasErrorAsync(run, errMsg, ct);
        }
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

    /// <summary>
    /// 将输入参考图 / 输出生成图的 COS URL 写入 LLM 日志（按 requestId 匹配）。
    /// 输入图来自前端传递的 COS URL（零重复存储），输出图来自生成结果。
    /// </summary>
    private async Task PatchLogImagesAsync(
        ImageGenRun run,
        int curItemIndex,
        int imageIndex,
        List<ImageRefData> loadedImageRefs,
        List<ImageGenImage>? outputImages,
        CancellationToken ct)
    {
        try
        {
            var logRequestId = $"{run.Id}-{curItemIndex}-{imageIndex}";

            // input：优先用前端传入的 COS URL（run.ImageRefs），回退到 loadedImageRefs
            var inputs = new List<LlmLogImage>();
            if (run.ImageRefs is { Count: > 0 })
            {
                foreach (var r in run.ImageRefs)
                {
                    var cosUrl = !string.IsNullOrWhiteSpace(r.Url) ? r.Url
                        : loadedImageRefs.FirstOrDefault(lr => lr.RefId == r.RefId)?.CosUrl;
                    if (string.IsNullOrWhiteSpace(cosUrl)) continue;
                    inputs.Add(new LlmLogImage
                    {
                        Url = cosUrl,
                        Label = r.Label,
                        Sha256 = !string.IsNullOrWhiteSpace(r.AssetSha256) ? r.AssetSha256
                            : loadedImageRefs.FirstOrDefault(lr => lr.RefId == r.RefId)?.Sha256
                    });
                }
            }

            // 蒙版：将 MaskBase64 作为额外的输入图记录（data URI 可直接用于前端 <img> 展示）
            if (!string.IsNullOrWhiteSpace(run.MaskBase64))
            {
                var maskUrl = run.MaskBase64.StartsWith("data:", StringComparison.OrdinalIgnoreCase)
                    ? run.MaskBase64
                    : $"data:image/png;base64,{run.MaskBase64}";
                inputs.Add(new LlmLogImage
                {
                    Url = maskUrl,
                    Label = "蒙版"
                });
            }

            // output：生成结果图
            var outputs = new List<LlmLogImage>();
            if (outputImages is { Count: > 0 })
            {
                foreach (var img in outputImages)
                {
                    var displayUrl = img.Url;
                    if (string.IsNullOrWhiteSpace(displayUrl)) continue;
                    outputs.Add(new LlmLogImage
                    {
                        Url = displayUrl,
                        OriginalUrl = img.OriginalUrl,
                        Label = "生成结果",
                        Sha256 = img.OriginalSha256
                    });
                }
            }

            if (inputs.Count == 0 && outputs.Count == 0) return;

            var update = Builders<LlmRequestLog>.Update;
            var updates = new List<UpdateDefinition<LlmRequestLog>>();
            if (inputs.Count > 0) updates.Add(update.Set(x => x.InputImages, inputs));
            if (outputs.Count > 0) updates.Add(update.Set(x => x.OutputImages, outputs));

            await _db.LlmRequestLogs.UpdateOneAsync(
                x => x.RequestId == logRequestId,
                update.Combine(updates),
                cancellationToken: ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ImageGenRunWorker] PatchLogImages 失败: RunId={RunId}", run.Id);
        }
    }

    /// <summary>
    /// 在 image_master_messages 中保存一条消息（服务器权威性：消息由后端保存，不依赖前端补存）
    /// </summary>
    private async Task<string?> SaveWorkspaceMessageAsync(string workspaceId, string ownerUserId, string role, string content, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(workspaceId)) return null;
        try
        {
            var m = new ImageMasterMessage
            {
                Id = Guid.NewGuid().ToString("N"),
                WorkspaceId = workspaceId,
                OwnerUserId = ownerUserId,
                Role = role,
                Content = content.Length > 64 * 1024 ? content[..(64 * 1024)] : content,
                CreatedAt = DateTime.UtcNow
            };
            await _db.ImageMasterMessages.InsertOneAsync(m, cancellationToken: ct);
            await _db.ImageMasterWorkspaces.UpdateOneAsync(
                x => x.Id == workspaceId,
                Builders<ImageMasterWorkspace>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
            return m.Id;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ImageGenRunWorker] 保存消息失败: workspaceId={WorkspaceId}", workspaceId);
            return null;
        }
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

    /// <summary>
    /// 剥离前端追加的生图意图前缀（支持循环剥除历史积累的多重前缀），
    /// 该前缀仅用于 LLM 调用，不应存入展示字段。
    /// </summary>
    private static string StripImageGenPrefix(string prompt)
    {
        const string prefix = "Generate an image based on the following description:\n";
        var result = prompt;
        while (result.StartsWith(prefix, StringComparison.Ordinal))
        {
            result = result[prefix.Length..].TrimStart('\n');
        }
        return result.Trim();
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

        // 原图已由生图网关客户端保存到 imagemaster 目录
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

            RegistryAssetStorage.OverrideNextScope("generated");
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
            Prompt = StripImageGenPrefix((prompt ?? string.Empty).Trim()),
            CreatedAt = DateTime.UtcNow,
            OriginalUrl = assetUrl,
            OriginalSha256 = assetSha256,
            ArticleInsertionIndex = run.ArticleMarkerIndex,
        };
        if (asset.Prompt != null && asset.Prompt.Length > 300) asset.Prompt = asset.Prompt[..300].Trim();

        var sizeForMeta = string.IsNullOrWhiteSpace(effectiveSize) ? requestedSize : effectiveSize!;
        if (TryParseWxH(sizeForMeta, out var w, out var h))
        {
            asset.Width = w;
            asset.Height = h;
        }

        await _db.ImageAssets.InsertOneAsync(asset, cancellationToken: ct);

        // 注意：文学创作的 AssetIdByMarkerIndex / DoneImageCount / marker 指针回填统一交由
        // TryPatchArticleMarkerAsync 在"最新成功优先"的时间戳 RMW 内原子写入（见成功路径调用），
        // 这里不再单独写指针，避免旧 run 绕过时间戳覆盖新成功结果。

        await TryPatchWorkspaceCanvasAsync(run, asset, ct);
        return asset;
    }

    private async Task TryPatchWorkspaceCanvasAsync(ImageGenRun run, ImageAsset asset, CancellationToken ct)
    {
        var wid = (run.WorkspaceId ?? string.Empty).Trim();
        var key = (run.TargetCanvasKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid) || string.IsNullOrWhiteSpace(key)) return;

        // 最新成功优先：用 run.CreatedAt（毫秒）作时间戳，旧 run 不覆盖已被更新 run 成功回填的画布元素。
        // （失败路径 TryMarkWorkspaceCanvasErrorAsync 本就只动占位元素、不抹成功图，故画布侧只需守成功排序。）
        var myStamp = new DateTimeOffset(DateTime.SpecifyKind(run.CreatedAt, DateTimeKind.Utc)).ToUnixTimeMilliseconds();

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
                    ["imageRunAt"] = myStamp,
                };
                // 占位元素缺失时，必须分配新的唯一 refId，避免复用输入图 refId 导致 @imgN 解析命中错误图片。
                o["refId"] = AllocateNextCanvasRefId(elements);
                if (run.TargetX.HasValue) o["x"] = run.TargetX.Value;
                if (run.TargetY.HasValue) o["y"] = run.TargetY.Value;
                if (run.TargetW.HasValue) o["w"] = run.TargetW.Value;
                if (run.TargetH.HasValue) o["h"] = run.TargetH.Value;
                elements.Add(o);
            }
            else
            {
                // 最新成功优先：已有同样新或更新的成功图则跳过（防止旧 run 覆盖新成功结果）
                var existingStamp = target["imageRunAt"]?.GetValue<long>() ?? 0L;
                if (existingStamp >= myStamp)
                {
                    _logger.LogInformation(
                        "[画布] 跳过成功回填：已有更新的成功图。WorkspaceId={WorkspaceId}, Key={Key}, RunId={RunId}",
                        wid, key, run.Id);
                    return;
                }
                target["kind"] = "image";
                target["status"] = "done";
                target["syncStatus"] = "synced";
                target["syncError"] = null;
                target["src"] = asset.Url ?? "";
                target["assetId"] = asset.Id;
                target["sha256"] = asset.Sha256;
                target["imageRunAt"] = myStamp;
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
    /// 失败/取消兜底：把 TargetCanvasKey 对应的画布占位元素从 running 翻成 error。
    /// 只动仍是占位（无 src 且非 done）的元素，绝不覆盖已成功回填的图片。
    /// </summary>
    private async Task TryMarkWorkspaceCanvasErrorAsync(ImageGenRun run, string errorMessage, CancellationToken ct)
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
            var elements = root?["elements"] as JsonArray;
            if (elements == null) return;

            JsonObject? target = null;
            foreach (var n in elements)
            {
                if (n is not JsonObject o) continue;
                var k = (o["id"]?.GetValue<string>() ?? o["key"]?.GetValue<string>() ?? string.Empty).Trim();
                if (string.Equals(k, key, StringComparison.Ordinal)) { target = o; break; }
            }
            // 元素已被删除：不复活；已成功（done 或有 src）：不覆盖。
            if (target == null) return;
            var st = (target["status"]?.GetValue<string>() ?? string.Empty).Trim();
            var hasSrc = !string.IsNullOrWhiteSpace(target["src"]?.GetValue<string>());
            if (st == "done" || hasSrc) return;
            if (st == "error") return; // 已是 error，无需重复写

            target["status"] = "error";
            target["errorMessage"] = string.IsNullOrWhiteSpace(errorMessage) ? "生成失败" : errorMessage;
            target["syncStatus"] = "failed";

            var nextJson = root!.ToJsonString(new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            var now = DateTime.UtcNow;
            var res = await _db.ImageMasterCanvases.UpdateOneAsync(
                x => x.Id == canvas.Id && x.UpdatedAt == canvas.UpdatedAt,
                Builders<ImageMasterCanvas>.Update.Set(x => x.PayloadJson, nextJson).Set(x => x.UpdatedAt, now),
                cancellationToken: ct);
            if (res.ModifiedCount > 0) return;
        }
    }

    private static int AllocateNextCanvasRefId(JsonArray elements)
    {
        var maxRefId = 0;
        foreach (var n in elements)
        {
            if (n is not JsonObject o) continue;
            if (!TryGetPositiveIntFromNode(o["refId"], out var refId)) continue;
            if (refId > maxRefId) maxRefId = refId;
        }

        // 约定 refId 从 1 开始递增
        return maxRefId + 1;
    }

    private static bool TryGetPositiveIntFromNode(JsonNode? node, out int value)
    {
        value = 0;
        if (node is not JsonValue v) return false;

        if (v.TryGetValue<int>(out var intVal) && intVal > 0)
        {
            value = intVal;
            return true;
        }

        if (v.TryGetValue<long>(out var longVal) && longVal > 0 && longVal <= int.MaxValue)
        {
            value = (int)longVal;
            return true;
        }

        if (v.TryGetValue<double>(out var doubleVal) && doubleVal > 0 && doubleVal <= int.MaxValue)
        {
            value = (int)Math.Floor(doubleVal);
            return true;
        }

        if (v.TryGetValue<string>(out var strVal)
            && int.TryParse(strVal, out var parsed)
            && parsed > 0)
        {
            value = parsed;
            return true;
        }

        return false;
    }

    /// <summary>
    /// 文学创作场景：回填 ArticleIllustrationMarker 状态 + 成功时写入资产指针。
    /// 并发重生成/批量按"最新成功优先、失败不抹旧图"取舍（时间戳 = 产图 run 的 CreatedAt，与完成顺序无关）：
    ///   - 资产指针 AssetIdByMarkerIndex + DoneImageCount：用**每 marker 原子条件 $set**（门控字段
    ///     AssetRunAtByMarkerIndex），不走 workspace 乐观锁——后者会被消息保存等无关写入 churn 掉、
    ///     批量并发下重试耗尽就丢指针（投稿/进度依赖此映射，必须可靠）。
    ///   - marker 显示字段（Status/Url/AssetId/ImageRunAt）：尽力乐观锁 RMW，门控同一时间戳；
    ///     done 仅当 run.CreatedAt 更新才覆盖，error 在已有成功图时不写（兼容 ImageRunAt 出现前的存量成功 marker）。
    /// </summary>
    private async Task TryPatchArticleMarkerAsync(
        ImageGenRun run,
        string status,
        string? errorMessage,
        string? url,
        string? assetId,
        CancellationToken ct)
    {
        // 只有文学创作场景（有 ArticleMarkerIndex）才需要回填
        if (!run.ArticleMarkerIndex.HasValue) return;
        var wid = (run.WorkspaceId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return;

        var markerIndex = run.ArticleMarkerIndex.Value;
        var isDone = status == "done";
        var key = markerIndex.ToString();
        // 权威成功时间戳的字段路径（第 1 步指针写入与第 2 步显示门控共用，避免重复声明导致 CS0136）
        var stampPath = $"articleWorkflow.assetRunAtByMarkerIndex.{key}";

        // 1) 成功且有资产：可靠的"每 marker 原子 + 时间戳门控"指针写入（不依赖 workspace 乐观锁）。
        if (isDone && !string.IsNullOrWhiteSpace(assetId))
        {
            var pointerFilter = Builders<ImageMasterWorkspace>.Filter.And(
                Builders<ImageMasterWorkspace>.Filter.Eq(x => x.Id, wid),
                Builders<ImageMasterWorkspace>.Filter.Ne(x => x.ArticleWorkflow, null),
                Builders<ImageMasterWorkspace>.Filter.Or(
                    Builders<ImageMasterWorkspace>.Filter.Exists(stampPath, false),
                    Builders<ImageMasterWorkspace>.Filter.Lt(stampPath, run.CreatedAt)));
            var pointerUpdate = Builders<ImageMasterWorkspace>.Update
                .Set($"articleWorkflow.assetIdByMarkerIndex.{key}", assetId!)
                .Set(stampPath, run.CreatedAt)
                .Set("articleWorkflow.updatedAt", DateTime.UtcNow);
            await _db.ImageMasterWorkspaces.UpdateOneAsync(pointerFilter, pointerUpdate, cancellationToken: ct);

            // DoneImageCount 重算（读取最新字典）。并发完成时各 task 读到的快照新旧不一，
            // 用"仅当新值更大才写"的单调门控（Lt 过滤）防止陈旧的较小计数最后落地把数值压低；
            // 生图过程中指针只增不减，单调最大即收敛到真实值。
            var latest = await _db.ImageMasterWorkspaces.Find(x => x.Id == wid).FirstOrDefaultAsync(ct);
            if (latest?.ArticleWorkflow?.AssetIdByMarkerIndex != null)
            {
                var doneCount = latest.ArticleWorkflow.AssetIdByMarkerIndex.Values
                    .Where(v => !string.IsNullOrWhiteSpace(v)).Distinct().Count();
                await _db.ImageMasterWorkspaces.UpdateOneAsync(
                    Builders<ImageMasterWorkspace>.Filter.And(
                        Builders<ImageMasterWorkspace>.Filter.Eq(x => x.Id, wid),
                        Builders<ImageMasterWorkspace>.Filter.Lt(x => x.ArticleWorkflow!.DoneImageCount, doneCount)),
                    Builders<ImageMasterWorkspace>.Update.Set(x => x.ArticleWorkflow!.DoneImageCount, doneCount),
                    cancellationToken: ct);
            }
        }

        // 2) marker 显示字段：用**针对该 marker 子字段的定向 $set**（绝不整体替换 ArticleWorkflow），
        //    否则并发下用陈旧快照整体回写会抹掉其它 run 在第 1 步原子写入的
        //    AssetIdByMarkerIndex / AssetRunAtByMarkerIndex（High：跨 marker 互相覆盖）。
        //    先读一次用于门控评估（display 为尽力而为，指针已在第 1 步可靠写入；这里轻微 TOCTOU 可接受）。
        var ws = await _db.ImageMasterWorkspaces.Find(x => x.Id == wid).FirstOrDefaultAsync(ct);
        if (ws == null) return;
        var wf = ws.ArticleWorkflow;
        if (wf == null || wf.Markers == null || markerIndex < 0 || markerIndex >= wf.Markers.Count) return;
        var marker = wf.Markers[markerIndex];

        // 权威成功时间戳：以原子指针写入的 AssetRunAtByMarkerIndex 为准（display 可能落后于指针，
        // 必须一并参考，否则旧/失败 run 会把 display 改成与权威指针不一致的状态）。
        DateTime? authoritativeSuccessAt = null;
        if (wf.AssetRunAtByMarkerIndex != null && wf.AssetRunAtByMarkerIndex.TryGetValue(key, out var assetStamp))
        {
            authoritativeSuccessAt = assetStamp;
        }

        var mPath = $"articleWorkflow.markers.{markerIndex}";
        var F = Builders<ImageMasterWorkspace>.Filter;
        var U = Builders<ImageMasterWorkspace>.Update;

        if (isDone)
        {
            // 内存快速短路（最新成功优先）
            if ((marker.ImageRunAt.HasValue && run.CreatedAt <= marker.ImageRunAt.Value)
                || (authoritativeSuccessAt.HasValue && run.CreatedAt < authoritativeSuccessAt.Value))
            {
                return;
            }
            // 原子门控：写入 filter 携带权威时间戳守卫，仅当本 run 仍是最新成功（无严格更新的指针）才落地，
            // 否则陈旧 run 通过内存门控后仍可能后落地覆盖更新 run 的 display（Codex/Bugbot：stale 覆盖 newer）。
            var doneFilter = F.And(
                F.Eq(x => x.Id, wid),
                F.Or(F.Exists(stampPath, false), F.Lte(stampPath, run.CreatedAt)));
            var doneUpdates = new List<UpdateDefinition<ImageMasterWorkspace>>
            {
                U.Set($"{mPath}.status", "done"),
                U.Set($"{mPath}.errorMessage", (string?)null),
                U.Set($"{mPath}.imageRunAt", run.CreatedAt),
                U.Set($"{mPath}.updatedAt", DateTime.UtcNow),
                U.Set("articleWorkflow.updatedAt", DateTime.UtcNow),
            };
            if (!string.IsNullOrWhiteSpace(url)) doneUpdates.Add(U.Set($"{mPath}.url", url));
            if (!string.IsNullOrWhiteSpace(assetId)) doneUpdates.Add(U.Set($"{mPath}.assetId", assetId));
            await _db.ImageMasterWorkspaces.UpdateOneAsync(doneFilter, U.Combine(doneUpdates), cancellationToken: ct);
            return;
        }

        // 失败分支
        var hasSuccessImage = authoritativeSuccessAt.HasValue
            || marker.ImageRunAt.HasValue
            || !string.IsNullOrWhiteSpace(marker.AssetId)
            || (string.Equals(marker.Status, "done", StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(marker.Url));
        if (hasSuccessImage)
        {
            // 失败但已有成功图：把因重生成而被置为 running 的 marker 恢复为 done（保留旧图），不写错误、不动图片字段，
            // 否则 marker 会卡在 running（Bugbot：regen fail leaves marker running）。
            await _db.ImageMasterWorkspaces.UpdateOneAsync(
                F.Eq(x => x.Id, wid),
                U.Combine(
                    U.Set($"{mPath}.status", "done"),
                    U.Set($"{mPath}.errorMessage", (string?)null),
                    U.Set($"{mPath}.updatedAt", DateTime.UtcNow),
                    U.Set("articleWorkflow.updatedAt", DateTime.UtcNow)),
                cancellationToken: ct);
            _logger.LogInformation(
                "[文学创作] 失败但已有成功图：marker 恢复 done 保留旧图。WorkspaceId={WorkspaceId}, MarkerIndex={MarkerIndex}, RunId={RunId}",
                wid, markerIndex, run.Id);
            return;
        }
        // 无成功图：写 error，filter 守卫"无成功指针"，避免并发成功后被错误覆盖。
        var errUpdates = new List<UpdateDefinition<ImageMasterWorkspace>>
        {
            U.Set($"{mPath}.status", status),
            U.Set($"{mPath}.updatedAt", DateTime.UtcNow),
            U.Set("articleWorkflow.updatedAt", DateTime.UtcNow),
        };
        if (!string.IsNullOrWhiteSpace(errorMessage)) errUpdates.Add(U.Set($"{mPath}.errorMessage", errorMessage));
        await _db.ImageMasterWorkspaces.UpdateOneAsync(
            F.And(F.Eq(x => x.Id, wid), F.Exists(stampPath, false)),
            U.Combine(errUpdates),
            cancellationToken: ct);
    }

    private async Task TryPatchWeeklyPosterPageAsync(ImageGenRun run, int itemIndex, string? imageUrl, CancellationToken ct)
    {
        var posterId = (run.WeeklyPosterId ?? string.Empty).Trim();
        var url = (imageUrl ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(posterId) || string.IsNullOrWhiteSpace(url)) return;

        var order = run.Items.ElementAtOrDefault(itemIndex)?.TargetPageOrder ?? itemIndex;
        var filter = Builders<WeeklyPosterAnnouncement>.Filter.And(
            Builders<WeeklyPosterAnnouncement>.Filter.Eq(x => x.Id, posterId),
            Builders<WeeklyPosterAnnouncement>.Filter.ElemMatch(x => x.Pages, p => p.Order == order));
        var update = Builders<WeeklyPosterAnnouncement>.Update
            .Set("Pages.$.ImageUrl", url)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        var result = await _db.WeeklyPosters.UpdateOneAsync(filter, update, cancellationToken: ct);
        if (result.MatchedCount == 0)
        {
            _logger.LogWarning(
                "[WeeklyPoster] 生图完成但未找到可回填页面: posterId={PosterId}, order={Order}, runId={RunId}",
                posterId, order, run.Id);
        }
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
            var resolved = await gateway.ResolveModelAsync(appCallerCode, "generation", expectedModelCode, ct: ct);

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
