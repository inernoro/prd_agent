using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;

namespace PrdAgent.Api.Services;

/// <summary>
/// 生图任务后台执行器：将“批量生图”从 HTTP 连接中解耦，避免前端断线导致任务中断。
/// </summary>
public class ImageGenRunWorker : BackgroundService
{
    private readonly MongoDbContext _db;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<ImageGenRunWorker> _logger;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public ImageGenRunWorker(MongoDbContext db, IServiceScopeFactory scopeFactory, ILogger<ImageGenRunWorker> logger)
    {
        _db = db;
        _scopeFactory = scopeFactory;
        _logger = logger;
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
                        var res = await imageClient.GenerateAsync(
                            curPrompt,
                            n: 1,
                            size: reqSize,
                            responseFormat: run.ResponseFormat,
                            ct,
                            modelId: requestedModelId,
                            platformId: run.PlatformId,
                            modelName: run.ModelId);

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
                            revisedPrompt
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

    private async Task<long> NextSeqAsync(string runId, CancellationToken ct)
    {
        var filter = Builders<ImageGenRun>.Filter.Eq(x => x.Id, runId);
        var update = Builders<ImageGenRun>.Update.Inc(x => x.LastSeq, 1);
        var options = new FindOneAndUpdateOptions<ImageGenRun, ImageGenRun> { ReturnDocument = ReturnDocument.After };
        var updated = await _db.ImageGenRuns.FindOneAndUpdateAsync(filter, update, options, ct);
        if (updated == null) throw new InvalidOperationException("run not found");
        return updated.LastSeq;
    }

    private async Task AppendEventAsync(ImageGenRun run, string eventName, object payload, CancellationToken ct)
    {
        var seq = await NextSeqAsync(run.Id, ct);
        var json = JsonSerializer.Serialize(payload, JsonOptions);

        await _db.ImageGenRunEvents.InsertOneAsync(new ImageGenRunEvent
        {
            OwnerAdminId = run.OwnerAdminId,
            RunId = run.Id,
            Seq = seq,
            EventName = eventName,
            PayloadJson = json,
            CreatedAt = DateTime.UtcNow
        }, cancellationToken: ct);
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
        var filter = Builders<ImageGenRunItem>.Filter.Eq(x => x.RunId, run.Id)
                     & Builders<ImageGenRunItem>.Filter.Eq(x => x.ItemIndex, itemIndex)
                     & Builders<ImageGenRunItem>.Filter.Eq(x => x.ImageIndex, imageIndex);

        var update = Builders<ImageGenRunItem>.Update
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
}


