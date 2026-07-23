using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.LLM;

internal enum LlmLogOpType
{
    MarkFirstByte,
    MarkDone,
    MarkError
}

internal record LlmLogOp(LlmLogOpType Type, string LogId, object Payload);
internal sealed record LlmImageStoreOp(string LogId, List<LlmLogImagePayload> Images);

/// <summary>
/// LLM 日志状态写入队列（高可靠，不丢弃）
/// </summary>
internal static class LlmLogQueue
{
    // 仅承载 FirstByte/Done/Error 这类“每次请求最多几条”的关键状态，必须必达。
    // 使用无界队列避免 DropWrite 导致状态长期 running。
    public static readonly Channel<LlmLogOp> Queue = Channel.CreateUnbounded<LlmLogOp>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = false, AllowSynchronousContinuations = true });
}

/// <summary>
/// MongoDB 日志状态写入后台（保证 done/error/firstByte 必达）
/// </summary>
public sealed class LlmRequestLogBackground
{
    private readonly MongoDbContext _db;
    private readonly ILogger<LlmRequestLogBackground> _logger;
    private readonly IAssetStorage _assetStorage;
    private readonly Channel<LlmImageStoreOp> _imageStoreQueue;
    private static readonly int[] RetryDelaysMs = [100, 300, 1000, 2000, 5000];

    public LlmRequestLogBackground(
        MongoDbContext db,
        ILogger<LlmRequestLogBackground> logger,
        IAssetStorage assetStorage)
    {
        _db = db;
        _logger = logger;
        _assetStorage = assetStorage;
        _imageStoreQueue = Channel.CreateBounded<LlmImageStoreOp>(
            new BoundedChannelOptions(32)
            {
                SingleReader = true,
                SingleWriter = false,
                AllowSynchronousContinuations = false,
                FullMode = BoundedChannelFullMode.Wait
            });

        _ = Task.Run(RunAsync);
        _ = Task.Run(RunImageStoreAsync);
    }

    private async Task RunAsync()
    {
        try
        {
            await foreach (var op in LlmLogQueue.Queue.Reader.ReadAllAsync())
            {
                try
                {
                    switch (op.Type)
                    {
                        case LlmLogOpType.MarkFirstByte:
                            await WithRetryAsync(op, () => UpdateFirstByteAsync(op.LogId, (DateTime)op.Payload));
                            break;
                        case LlmLogOpType.MarkDone:
                            await WithRetryAsync(op, () => UpdateDoneAsync(op.LogId, (LlmLogDone)op.Payload));
                            break;
                        case LlmLogOpType.MarkError:
                            var (err, code) = ((string, int?))op.Payload;
                            await WithRetryAsync(op, () => UpdateErrorAsync(op.LogId, err, code));
                            break;
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "LLM log background op failed: {Type}", op.Type);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "LLM log background loop crashed");
        }
    }

    private Task UpdateFirstByteAsync(string logId, DateTime at)
    {
        var update = Builders<LlmRequestLog>.Update.Set(l => l.FirstByteAt, at);
        return _db.LlmRequestLogs.UpdateOneAsync(l => l.Id == logId && l.FirstByteAt == null, update);
    }

    private async Task UpdateDoneAsync(string logId, LlmLogDone done)
    {
        // 二次保险：避免超长文本导致 Mongo 文档过大（使用系统配置，默认 200k）
        var answerText = done.AnswerText;
        var answerMaxChars = LlmLogLimits.DefaultAnswerMaxChars;
        if (!string.IsNullOrEmpty(answerText) && answerText.Length > answerMaxChars)
        {
            answerText = answerText[..answerMaxChars] + "...[TRUNCATED]";
        }

        // 思考过程文本同样做截断保护
        var thinkingText = done.ThinkingText;
        if (!string.IsNullOrEmpty(thinkingText) && thinkingText.Length > answerMaxChars)
        {
            thinkingText = thinkingText[..answerMaxChars] + "...[TRUNCATED]";
        }

        // 函数调用 JSON 同样截断保护
        var toolCalls = done.ResponseToolCalls;
        if (!string.IsNullOrEmpty(toolCalls) && toolCalls.Length > answerMaxChars)
        {
            toolCalls = toolCalls[..answerMaxChars] + "...[TRUNCATED]";
        }

        var update = Builders<LlmRequestLog>.Update
            .Set(l => l.StatusCode, done.StatusCode)
            .Set(l => l.ResponseHeaders, done.ResponseHeaders)
            .Set(l => l.InputTokens, done.InputTokens)
            .Set(l => l.OutputTokens, done.OutputTokens)
            .Set(l => l.CacheCreationInputTokens, done.CacheCreationInputTokens)
            .Set(l => l.CacheReadInputTokens, done.CacheReadInputTokens)
            .Set(l => l.TokenUsageSource, done.TokenUsageSource)
            .Set(l => l.ImageSuccessCount, done.ImageSuccessCount)
            .Set(l => l.AnswerText, answerText)
            .Set(l => l.ThinkingText, thinkingText)
            .Set(l => l.AnswerTextChars, done.AssembledTextChars)
            .Set(l => l.AnswerTextHash, done.AssembledTextHash)
            .Set(l => l.AssembledTextChars, done.AssembledTextChars)
            .Set(l => l.AssembledTextHash, done.AssembledTextHash)
            .Set(l => l.Status, done.Status)
            .Set(l => l.EndedAt, done.EndedAt)
            .Set(l => l.DurationMs, done.DurationMs)
            .Set(l => l.ResponseToolCalls, toolCalls)
            .Set(l => l.ToolCallCount, done.ToolCallCount)
            .Set(l => l.FinishReason, done.FinishReason)
            .Set(l => l.ProviderRequestId, LlmCostEvidence.ResolveProviderRequestId(done.ResponseHeaders))
            .Set(l => l.EstimatedInputCost, done.EstimatedInputCost)
            .Set(l => l.EstimatedOutputCost, done.EstimatedOutputCost)
            .Set(l => l.EstimatedCallCost, done.EstimatedCallCost)
            .Set(l => l.EstimatedCost, done.EstimatedCost)
            .Set(l => l.EstimatedCostCurrency, done.EstimatedCostCurrency)
            .Set(l => l.EstimatedCostUsd, done.EstimatedCostUsd)
            .Set(l => l.ProviderReportedCost, done.ProviderReportedCost)
            .Set(l => l.ProviderCostCurrency, done.ProviderCostCurrency);
        if (done.OutputImagePayloads is { Count: > 0 })
        {
            update = update
                .Set(l => l.OutputImageCaptureStatus, "pending")
                .Set(l => l.OutputImageCaptureError, null)
                .Set(l => l.OutputImageCapturedAt, null);
        }
        if (done.ProviderAttempts is not null)
        {
            update = update.Set(l => l.ProviderAttempts, done.ProviderAttempts);
        }
        if (!string.IsNullOrWhiteSpace(done.Provider))
            update = update.Set(l => l.Provider, done.Provider);
        if (!string.IsNullOrWhiteSpace(done.Model))
            update = update.Set(l => l.Model, done.Model);
        if (!string.IsNullOrWhiteSpace(done.ApiBase))
            update = update.Set(l => l.ApiBase, done.ApiBase);
        if (!string.IsNullOrWhiteSpace(done.Path))
            update = update.Set(l => l.Path, done.Path);
        if (!string.IsNullOrWhiteSpace(done.PlatformId))
            update = update.Set(l => l.PlatformId, done.PlatformId);
        if (!string.IsNullOrWhiteSpace(done.PlatformName))
            update = update.Set(l => l.PlatformName, done.PlatformName);
        if (!string.IsNullOrWhiteSpace(done.Protocol))
            update = update.Set(l => l.Protocol, done.Protocol);
        if (!string.IsNullOrWhiteSpace(done.ResolutionReason))
            update = update.Set(l => l.ResolutionReason, done.ResolutionReason);
        if (done.ModelResolutionType.HasValue)
            update = update.Set(l => l.ModelResolutionType, done.ModelResolutionType);
        if (!string.IsNullOrWhiteSpace(done.ModelGroupId))
            update = update.Set(l => l.ModelGroupId, done.ModelGroupId);
        if (!string.IsNullOrWhiteSpace(done.ModelGroupName))
            update = update.Set(l => l.ModelGroupName, done.ModelGroupName);

        // blackhole 占位记录由 LlmRequestLogWriter.StartAsync 失败路径返回 null 保护——logId 永不复用，
        // 故这里无需再按 Status 过滤；按主键直接更新即可。
        await _db.LlmRequestLogs.UpdateOneAsync(l => l.Id == logId, update);

        if (done.OutputImagePayloads is not { Count: > 0 }) return;
        if (_imageStoreQueue.Writer.TryWrite(new LlmImageStoreOp(logId, done.OutputImagePayloads))) return;

        await _db.LlmRequestLogs.UpdateOneAsync(
            l => l.Id == logId,
            Builders<LlmRequestLog>.Update
                .Set(l => l.OutputImageCaptureStatus, "queue_full")
                .Set(l => l.OutputImageCaptureError, "图片存储队列已满，响应本身不受影响"));
    }

    private async Task RunImageStoreAsync()
    {
        try
        {
            await foreach (var op in _imageStoreQueue.Reader.ReadAllAsync())
            {
                try
                {
                    var storedImages = new List<LlmLogImage>(op.Images.Count);
                    foreach (var image in op.Images)
                    {
                        var bytes = Convert.FromBase64String(image.Base64Data);
                        var stored = await _assetStorage.SaveAsync(
                            bytes,
                            image.MimeType,
                            CancellationToken.None,
                            domain: AppDomainPaths.DomainLogs,
                            type: AppDomainPaths.TypeImg);
                        storedImages.Add(new LlmLogImage
                        {
                            Url = stored.Url,
                            OriginalUrl = stored.Url,
                            Label = "生成结果",
                            Sha256 = stored.Sha256,
                            MimeType = stored.Mime,
                            SizeBytes = stored.SizeBytes
                        });
                    }

                    await _db.LlmRequestLogs.UpdateOneAsync(
                        l => l.Id == op.LogId,
                        Builders<LlmRequestLog>.Update
                            .Set(l => l.OutputImages, storedImages)
                            .Set(l => l.OutputImageCaptureStatus, "stored")
                            .Set(l => l.OutputImageCaptureError, null)
                            .Set(l => l.OutputImageCapturedAt, DateTime.UtcNow));
                }
                catch (Exception ex)
                {
                    var error = ex.Message.Length > 500 ? ex.Message[..500] : ex.Message;
                    _logger.LogWarning(ex, "LLM output image persistence failed: {LogId}", op.LogId);
                    await _db.LlmRequestLogs.UpdateOneAsync(
                        l => l.Id == op.LogId,
                        Builders<LlmRequestLog>.Update
                            .Set(l => l.OutputImageCaptureStatus, "failed")
                            .Set(l => l.OutputImageCaptureError, error));
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "LLM output image persistence loop crashed");
        }
    }

    private async Task UpdateErrorAsync(string logId, string error, int? statusCode)
    {
        var errorMaxChars = LlmLogLimits.DefaultErrorMaxChars;
        if (!string.IsNullOrEmpty(error) && error.Length > errorMaxChars) error = error[..errorMaxChars] + "...[TRUNCATED]";
        var endedAt = DateTime.UtcNow;
        var update = Builders<LlmRequestLog>.Update
            .Set(l => l.Error, error)
            .Set(l => l.StatusCode, statusCode)
            .Set(l => l.Status, "failed")
            .Set(l => l.EndedAt, endedAt);

        // 同上：blackhole 占位记录的 logId 不会被复用（StartAsync 失败返回 null），按主键直接更新即可。
        await _db.LlmRequestLogs.UpdateOneAsync(l => l.Id == logId, update);

        var attemptUpdate = Builders<LlmRequestLog>.Update
            .Set("ProviderAttempts.$[send].Status", "failed")
            .Set("ProviderAttempts.$[send].StatusCode", statusCode)
            .Set("ProviderAttempts.$[send].Error", error)
            .Set("ProviderAttempts.$[send].EndedAt", endedAt);

        var attemptFilter = Builders<LlmRequestLog>.Filter.And(
            Builders<LlmRequestLog>.Filter.Eq(l => l.Id, logId),
            Builders<LlmRequestLog>.Filter.Exists("ProviderAttempts.0", true),
            Builders<LlmRequestLog>.Filter.ElemMatch(l => l.ProviderAttempts, a => a.Status == "sent"));

        await _db.LlmRequestLogs.UpdateOneAsync(
            attemptFilter,
            attemptUpdate,
            new UpdateOptions
            {
                ArrayFilters =
                [
                    new BsonDocumentArrayFilterDefinition<LlmProviderAttempt>(
                        new MongoDB.Bson.BsonDocument("send.Status", "sent"))
                ]
            });
    }

    private async Task WithRetryAsync(LlmLogOp op, Func<Task> action)
    {
        for (var i = 0; i < RetryDelaysMs.Length + 1; i++)
        {
            try
            {
                await action();
                return;
            }
            catch (Exception ex) when (i < RetryDelaysMs.Length)
            {
                _logger.LogDebug(ex, "LLM log update retrying: {Type} {LogId} attempt={Attempt}", op.Type, op.LogId, i + 1);
                await Task.Delay(RetryDelaysMs[i]);
            }
        }

        // 最终失败：交给 watchdog 做兜底纠错
        _logger.LogWarning("LLM log update failed permanently: {Type} {LogId}", op.Type, op.LogId);
    }
}
