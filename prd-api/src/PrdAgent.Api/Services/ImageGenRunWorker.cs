using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
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
        await ResolveModelGroupAsync(run, ct);

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

                        // ImageMaster：支持“首帧资产 sha”图生图（服务端读取；前端可关闭页面）
                        string? initImageBase64 = null;
                        var initSha = (run.InitImageAssetSha256 ?? string.Empty).Trim().ToLowerInvariant();
                        if (!string.IsNullOrWhiteSpace(initSha) && initSha.Length == 64 && Regex.IsMatch(initSha, "^[0-9a-f]{64}$"))
                        {
                            var found = await assetStorage.TryReadByShaAsync(initSha, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
                            if (found != null && found.Value.bytes.Length > 0)
                            {
                                var mime = string.IsNullOrWhiteSpace(found.Value.mime) ? "image/png" : found.Value.mime.Trim();
                                var b64 = Convert.ToBase64String(found.Value.bytes);
                                initImageBase64 = $"data:{mime};base64,{b64}";
                            }
                        }

                        _logger.LogInformation("[ImageGenRunWorker Debug] Run {RunId}: AppKey={AppKey}, UserId={UserId}, AppCallerCode={AppCallerCode}",
                            run.Id, run.AppKey ?? "(null)", run.OwnerAdminId, run.AppCallerCode ?? "(null)");

                        // AppCallerCode: 优先使用 run.AppCallerCode，否则根据 AppKey 生成，最后回退到默认值
                        var appCallerCode = run.AppCallerCode;
                        if (string.IsNullOrWhiteSpace(appCallerCode) && !string.IsNullOrWhiteSpace(run.AppKey))
                        {
                            appCallerCode = $"{run.AppKey}.image::generation";
                        }
                        appCallerCode ??= "prd-agent-web.image::generation"; // 最终回退（符合命名规范）

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

                        _logger.LogInformation("[ImageGenRunWorker Debug] Calling GenerateAsync with appKey={AppKey}", run.AppKey ?? "(null)");

                        var res = await imageClient.GenerateAsync(
                            curPrompt,
                            n: 1,
                            size: reqSize,
                            responseFormat: run.ResponseFormat,
                            ct,
                            modelId: requestedModelId,
                            platformId: run.PlatformId,
                            modelName: run.ModelId,
                            initImageBase64: initImageBase64,
                            initImageProvided: initImageBase64 != null,
                            appKey: run.AppKey);

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
    /// 模型池调度：统一在 Worker 中处理，确保所有来源的 Run 都能正确关联模型池
    /// 仅通过 AppCaller 绑定关系查询模型池，不进行 platformId+modelId 反查
    /// </summary>
    private async Task ResolveModelGroupAsync(ImageGenRun run, CancellationToken ct)
    {
        // ========== 关键日志：前端期望的模型 ==========
        _logger.LogInformation(
            "[ImageGenRunWorker] ===== 模型调度开始 =====\n" +
            "  RunId: {RunId}\n" +
            "  前端期望模型:\n" +
            "    - ConfigModelId: {ConfigModelId}\n" +
            "    - PlatformId: {PlatformId}\n" +
            "    - ModelId: {ModelId}\n" +
            "  AppKey: {AppKey}\n" +
            "  AppCallerCode: {AppCallerCode}\n" +
            "  已有 ModelGroupId: {ModelGroupId}",
            run.Id, run.ConfigModelId ?? "(null)", run.PlatformId ?? "(null)", run.ModelId ?? "(null)", 
            run.AppKey ?? "(null)", run.AppCallerCode ?? "(null)", run.ModelGroupId ?? "(null)");

        // 如果已经有模型解析类型信息，跳过
        if (run.ModelResolutionType.HasValue)
        {
            _logger.LogInformation("[ImageGenRunWorker] 已有模型解析类型信息，跳过: resolutionType={ResolutionType}", run.ModelResolutionType);
            return;
        }

        ModelResolutionType resolutionType = ModelResolutionType.DirectModel; // 默认为直连单模型
        string? modelGroupId = null;
        string? modelGroupName = null;
        string? resolvedPlatformId = null;
        string? resolvedModelId = null;

        // 通过 AppCaller 从模型池中选择模型（唯一方式）
        var appCallerCode = run.AppCallerCode;
        if (string.IsNullOrWhiteSpace(appCallerCode) && !string.IsNullOrWhiteSpace(run.AppKey))
        {
            appCallerCode = $"{run.AppKey}.image::generation";
        }
        
        _logger.LogInformation("[ImageGenRunWorker] 计算后的 AppCallerCode: {AppCallerCode}", appCallerCode ?? "(null)");

        if (!string.IsNullOrWhiteSpace(appCallerCode))
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var scheduler = scope.ServiceProvider.GetRequiredService<ISmartModelScheduler>();
                
                // 查询 AppCaller 绑定的模型池
                var appCaller = await _db.LLMAppCallers.Find(a => a.AppCode == appCallerCode).FirstOrDefaultAsync(ct);
                if (appCaller != null)
                {
                    var requirement = appCaller.ModelRequirements.FirstOrDefault(r => r.ModelType == "generation");
                    _logger.LogInformation(
                        "[ImageGenRunWorker] AppCaller 查询结果:\n" +
                        "  AppCode: {AppCode}\n" +
                        "  DisplayName: {DisplayName}\n" +
                        "  generation 类型需求: {HasRequirement}\n" +
                        "  绑定的模型池IDs: [{ModelGroupIds}]",
                        appCaller.AppCode, appCaller.DisplayName, requirement != null,
                        requirement?.ModelGroupIds != null ? string.Join(", ", requirement.ModelGroupIds) : "(无)");
                    
                    // 查询绑定的模型池详情
                    if (requirement?.ModelGroupIds != null && requirement.ModelGroupIds.Count > 0)
                    {
                        foreach (var gid in requirement.ModelGroupIds)
                        {
                            var grp = await _db.ModelGroups.Find(g => g.Id == gid).FirstOrDefaultAsync(ct);
                            if (grp != null)
                            {
                                var modelList = grp.Models.Select(m => $"{m.PlatformId}:{m.ModelId}(优先级:{m.Priority},状态:{m.HealthStatus})").ToList();
                                _logger.LogInformation(
                                    "[ImageGenRunWorker] 模型池详情:\n" +
                                    "  Id: {Id}\n" +
                                    "  Name: {Name}\n" +
                                    "  Code: {Code}\n" +
                                    "  ModelType: {ModelType}\n" +
                                    "  IsDefaultForType: {IsDefault}\n" +
                                    "  包含模型: [{Models}]",
                                    grp.Id, grp.Name, grp.Code ?? "(null)", grp.ModelType, grp.IsDefaultForType,
                                    string.Join("; ", modelList));
                            }
                        }
                    }
                }
                else
                {
                    _logger.LogInformation("[ImageGenRunWorker] 未找到 AppCaller: {AppCallerCode}，将自动注册并使用默认模型池", appCallerCode);
                }
                
                var resolved = await scheduler.ResolveModelAsync(appCallerCode, "generation", ct);

                _logger.LogInformation(
                    "[ImageGenRunWorker] SmartModelScheduler.ResolveModelAsync 结果:\n" +
                    "  有结果: {HasResolved}\n" +
                    "  ResolutionType: {ResolutionType}\n" +
                    "  ModelGroupId: {ModelGroupId}\n" +
                    "  ModelGroupName: {ModelGroupName}\n" +
                    "  PlatformId: {PlatformId}\n" +
                    "  ModelId: {ModelId}",
                    resolved != null, resolved?.ResolutionType, resolved?.ModelGroupId ?? "(null)", 
                    resolved?.ModelGroupName ?? "(null)", resolved?.PlatformId ?? "(null)", resolved?.ModelId ?? "(null)");

                if (resolved != null)
                {
                    resolutionType = resolved.ResolutionType;
                    modelGroupId = resolved.ModelGroupId;
                    modelGroupName = resolved.ModelGroupName;
                    resolvedPlatformId = resolved.PlatformId;
                    resolvedModelId = resolved.ModelId;
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[ImageGenRunWorker] 通过 AppCaller 获取模型池失败: appCallerCode={AppCallerCode}，将使用直连单模型", appCallerCode);
            }
        }

        // ========== 关键日志：最终决定 ==========
        var willOverride = !string.IsNullOrWhiteSpace(resolvedPlatformId) && !string.IsNullOrWhiteSpace(resolvedModelId);
        _logger.LogInformation(
            "[ImageGenRunWorker] ===== 模型调度结果 =====\n" +
            "  是否覆盖前端选择: {WillOverride}\n" +
            "  ResolutionType: {ResolutionType}\n" +
            "  ModelGroupId: {ModelGroupId}\n" +
            "  ModelGroupName: {ModelGroupName}\n" +
            "  最终 PlatformId: {FinalPlatformId} (前端期望: {OriginalPlatformId})\n" +
            "  最终 ModelId: {FinalModelId} (前端期望: {OriginalModelId})",
            willOverride, resolutionType, modelGroupId ?? "(null)", modelGroupName ?? "(null)",
            willOverride ? resolvedPlatformId : run.PlatformId, run.PlatformId ?? "(null)",
            willOverride ? resolvedModelId : run.ModelId, run.ModelId ?? "(null)");

        // 更新 Run 对象和数据库
        var updateDef = Builders<ImageGenRun>.Update
            .Set(x => x.ModelResolutionType, resolutionType)
            .Set(x => x.ModelGroupId, modelGroupId)
            .Set(x => x.ModelGroupName, modelGroupName);

        // 如果通过模型池调度获取了新的 platformId 和 modelId，也一并更新
        if (willOverride)
        {
            _logger.LogWarning(
                "[ImageGenRunWorker] !!! 注意：模型池调度覆盖了前端选择 !!!\n" +
                "  原 PlatformId: {OriginalPlatformId} -> 新: {NewPlatformId}\n" +
                "  原 ModelId: {OriginalModelId} -> 新: {NewModelId}\n" +
                "  原因: AppCallerCode '{AppCallerCode}' 绑定了模型池 '{ModelGroupName}'",
                run.PlatformId ?? "(null)", resolvedPlatformId,
                run.ModelId ?? "(null)", resolvedModelId,
                appCallerCode, modelGroupName ?? "(unknown)");
                
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
        
        _logger.LogInformation("[ImageGenRunWorker] ===== 模型调度完成 =====");
    }
}

