using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.LLM;

internal enum LlmLogOpType
{
    MarkFirstByte,
    MarkDone,
    MarkError
}

internal record LlmLogOp(LlmLogOpType Type, string LogId, object Payload);

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
    private static readonly int[] RetryDelaysMs = [100, 300, 1000, 2000, 5000];

    public LlmRequestLogBackground(MongoDbContext db, ILogger<LlmRequestLogBackground> logger)
    {
        _db = db;
        _logger = logger;

        _ = Task.Run(RunAsync);
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

    private Task UpdateDoneAsync(string logId, LlmLogDone done)
    {
        // 二次保险：避免超长文本导致 Mongo 文档过大
        var answerText = done.AnswerText;
        if (!string.IsNullOrEmpty(answerText) && answerText.Length > 200_000)
        {
            answerText = answerText[..200_000] + "...[TRUNCATED]";
        }

        var update = Builders<LlmRequestLog>.Update
            .Set(l => l.StatusCode, done.StatusCode)
            .Set(l => l.ResponseHeaders, done.ResponseHeaders)
            .Set(l => l.InputTokens, done.InputTokens)
            .Set(l => l.OutputTokens, done.OutputTokens)
            .Set(l => l.CacheCreationInputTokens, done.CacheCreationInputTokens)
            .Set(l => l.CacheReadInputTokens, done.CacheReadInputTokens)
            .Set(l => l.AnswerText, answerText)
            .Set(l => l.AnswerTextChars, done.AssembledTextChars)
            .Set(l => l.AnswerTextHash, done.AssembledTextHash)
            .Set(l => l.AssembledTextChars, done.AssembledTextChars)
            .Set(l => l.AssembledTextHash, done.AssembledTextHash)
            .Set(l => l.Status, done.Status)
            .Set(l => l.EndedAt, done.EndedAt)
            .Set(l => l.DurationMs, done.DurationMs);

        return _db.LlmRequestLogs.UpdateOneAsync(l => l.Id == logId, update);
    }

    private Task UpdateErrorAsync(string logId, string error, int? statusCode)
    {
        if (!string.IsNullOrEmpty(error) && error.Length > 20_000) error = error[..20_000] + "...[TRUNCATED]";
        var update = Builders<LlmRequestLog>.Update
            .Set(l => l.Error, error)
            .Set(l => l.StatusCode, statusCode)
            .Set(l => l.Status, "failed")
            .Set(l => l.EndedAt, DateTime.UtcNow);

        return _db.LlmRequestLogs.UpdateOneAsync(l => l.Id == logId, update);
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

