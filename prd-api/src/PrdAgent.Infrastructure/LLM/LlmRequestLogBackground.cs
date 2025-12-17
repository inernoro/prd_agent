using System.Collections.Concurrent;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.LLM;

internal enum LlmLogOpType
{
    AppendRawSse,
    MarkFirstByte,
    MarkDone,
    MarkError
}

internal record LlmLogOp(LlmLogOpType Type, string LogId, object Payload);

/// <summary>
/// LLM 日志写入队列（旁路、限流、批处理）
/// </summary>
internal static class LlmLogQueue
{
    // 轻度限流：队列满时直接丢弃，避免影响主流程
    public static readonly Channel<LlmLogOp> Queue = System.Threading.Channels.Channel.CreateBounded<LlmLogOp>(
        new BoundedChannelOptions(10_000)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropWrite
        });
}

/// <summary>
/// MongoDB 日志批量写入后台
/// </summary>
public sealed class LlmRequestLogBackground
{
    private readonly MongoDbContext _db;
    private readonly ILogger<LlmRequestLogBackground> _logger;

    // 缓冲：按 logId 聚合 raw SSE 行
    private readonly ConcurrentDictionary<string, List<string>> _rawBuffers = new();
    private readonly ConcurrentDictionary<string, int> _rawCounts = new();

    // 上限：最多保存 N 行 raw SSE（每行也会被截断）
    private const int MaxRawLines = 2000;
    private const int MaxLineChars = 2000;

    public LlmRequestLogBackground(MongoDbContext db, ILogger<LlmRequestLogBackground> logger)
    {
        _db = db;
        _logger = logger;

        _ = Task.Run(RunAsync);
    }

    private async Task RunAsync()
    {
        var lastFlush = DateTime.UtcNow;
        try
        {
            await foreach (var op in LlmLogQueue.Queue.Reader.ReadAllAsync())
            {
                try
                {
                    switch (op.Type)
                    {
                        case LlmLogOpType.AppendRawSse:
                            BufferRaw(op.LogId, (string)op.Payload);
                            break;
                        case LlmLogOpType.MarkFirstByte:
                            await UpdateFirstByteAsync(op.LogId, (DateTime)op.Payload);
                            break;
                        case LlmLogOpType.MarkDone:
                            await FlushRawAsync(op.LogId);
                            await UpdateDoneAsync(op.LogId, (LlmLogDone)op.Payload);
                            break;
                        case LlmLogOpType.MarkError:
                            await FlushRawAsync(op.LogId);
                            var (err, code) = ((string, int?))op.Payload;
                            await UpdateErrorAsync(op.LogId, err, code);
                            break;
                    }

                    // 周期性刷新 raw buffer（避免积压）
                    if ((DateTime.UtcNow - lastFlush).TotalMilliseconds >= 250)
                    {
                        lastFlush = DateTime.UtcNow;
                        await FlushAllRawAsync();
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

    private void BufferRaw(string logId, string line)
    {
        if (string.IsNullOrWhiteSpace(logId)) return;
        if (line.Length > MaxLineChars) line = line[..MaxLineChars] + "...[TRUNCATED]";

        var list = _rawBuffers.GetOrAdd(logId, _ => new List<string>(32));
        _rawCounts.AddOrUpdate(logId, _ => 1, (_, cur) => cur + 1);
        lock (list)
        {
            list.Add(line);
            if (list.Count >= 64)
            {
                // 尽快 flush
                _ = FlushRawAsync(logId);
            }
        }
    }

    private async Task FlushAllRawAsync()
    {
        foreach (var key in _rawBuffers.Keys)
        {
            await FlushRawAsync(key);
        }
    }

    private async Task FlushRawAsync(string logId)
    {
        if (!_rawBuffers.TryGetValue(logId, out var list)) return;

        List<string> batch;
        lock (list)
        {
            if (list.Count == 0) return;
            batch = new List<string>(list);
            list.Clear();
        }

        try
        {
            var total = _rawCounts.TryGetValue(logId, out var c) ? c : 0;
            var update = Builders<LlmRequestLog>.Update.PushEach(
                l => l.RawSse,
                batch,
                slice: -MaxRawLines);
            if (total > MaxRawLines)
            {
                update = update.Set(l => l.RawSseTruncated, true);
            }

            await _db.LlmRequestLogs.UpdateOneAsync(l => l.Id == logId, update);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "FlushRaw failed: {LogId}", logId);
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

