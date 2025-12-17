using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// LLM 请求日志写入器（写入旁路，不影响主流程）\n/// </summary>
public class LlmRequestLogWriter : ILlmRequestLogWriter
{
    private readonly MongoDbContext _db;
    private readonly ILogger<LlmRequestLogWriter> _logger;

    public LlmRequestLogWriter(MongoDbContext db, ILogger<LlmRequestLogWriter> logger, LlmRequestLogBackground _)
    {
        _db = db;
        _logger = logger;
    }

    public async Task<string?> StartAsync(LlmLogStart start, CancellationToken ct = default)
    {
        try
        {
            var log = new LlmRequestLog
            {
                Id = Guid.NewGuid().ToString(),
                RequestId = start.RequestId,
                GroupId = start.GroupId,
                SessionId = start.SessionId,
                UserId = start.UserId,
                ViewRole = start.ViewRole,
                Provider = start.Provider,
                Model = start.Model,
                ApiBase = start.ApiBase,
                Path = start.Path,
                RequestHeadersRedacted = start.RequestHeadersRedacted,
                RequestBodyRedacted = Truncate(start.RequestBodyRedacted, 200_000),
                RequestBodyHash = start.RequestBodyHash ?? Sha256Hex(start.RequestBodyRedacted),
                SystemPromptChars = start.SystemPromptChars,
                SystemPromptHash = start.SystemPromptHash,
                MessageCount = start.MessageCount,
                DocumentChars = start.DocumentChars,
                DocumentHash = start.DocumentHash,
                StartedAt = start.StartedAt,
                Status = "running",
                RawSse = new List<string>(0),
                RawSseTruncated = false
            };

            await _db.LlmRequestLogs.InsertOneAsync(log, cancellationToken: ct);
            return log.Id;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "StartAsync failed");
            return null;
        }
    }

    public void AppendRawSse(string logId, string redactedLine)
    {
        if (string.IsNullOrWhiteSpace(logId)) return;
        if (string.IsNullOrEmpty(redactedLine)) return;
        LlmLogQueue.Queue.Writer.TryWrite(new LlmLogOp(LlmLogOpType.AppendRawSse, logId, redactedLine));
    }

    public void MarkFirstByte(string logId, DateTime at)
    {
        if (string.IsNullOrWhiteSpace(logId)) return;
        LlmLogQueue.Queue.Writer.TryWrite(new LlmLogOp(LlmLogOpType.MarkFirstByte, logId, at));
    }

    public void MarkDone(string logId, LlmLogDone done)
    {
        if (string.IsNullOrWhiteSpace(logId)) return;
        LlmLogQueue.Queue.Writer.TryWrite(new LlmLogOp(LlmLogOpType.MarkDone, logId, done));
    }

    public void MarkError(string logId, string error, int? statusCode = null)
    {
        if (string.IsNullOrWhiteSpace(logId)) return;
        var payload = (Truncate(error, 20_000), statusCode);
        LlmLogQueue.Queue.Writer.TryWrite(new LlmLogOp(LlmLogOpType.MarkError, logId, payload));
    }

    private static string Truncate(string s, int max)
    {
        if (string.IsNullOrEmpty(s)) return s;
        if (s.Length <= max) return s;
        return s[..max] + "...[TRUNCATED]";
    }

    private static string Sha256Hex(string input)
    {
        var bytes = Encoding.UTF8.GetBytes(input ?? string.Empty);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}

