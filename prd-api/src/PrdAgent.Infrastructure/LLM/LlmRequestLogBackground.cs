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
                            await UpdateFirstByteAsync(op.LogId, (DateTime)op.Payload);
                            break;
                        case LlmLogOpType.MarkDone:
                            await UpdateDoneAsync(op.LogId, (LlmLogDone)op.Payload);
                            break;
                        case LlmLogOpType.MarkError:
                            var (err, code) = ((string, int?))op.Payload;
                            await UpdateErrorAsync(op.LogId, err, code);
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
        var update = Builders<LlmRequestLog>.Update
            .Set(l => l.StatusCode, done.StatusCode)
            .Set(l => l.ResponseHeaders, done.ResponseHeaders)
            .Set(l => l.InputTokens, done.InputTokens)
            .Set(l => l.OutputTokens, done.OutputTokens)
            .Set(l => l.CacheCreationInputTokens, done.CacheCreationInputTokens)
            .Set(l => l.CacheReadInputTokens, done.CacheReadInputTokens)
            .Set(l => l.AnswerText, done.AnswerText)
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
        var update = Builders<LlmRequestLog>.Update
            .Set(l => l.Error, error)
            .Set(l => l.StatusCode, statusCode)
            .Set(l => l.Status, "failed")
            .Set(l => l.EndedAt, DateTime.UtcNow);

        return _db.LlmRequestLogs.UpdateOneAsync(l => l.Id == logId, update);
    }
}

