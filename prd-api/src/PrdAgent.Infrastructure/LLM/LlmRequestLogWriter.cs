using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
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
    private readonly IAppSettingsService _settingsService;

    public LlmRequestLogWriter(MongoDbContext db, ILogger<LlmRequestLogWriter> logger, LlmRequestLogBackground _, IAppSettingsService settingsService)
    {
        _db = db;
        _logger = logger;
        _settingsService = settingsService;
    }

    public async Task<string?> StartAsync(LlmLogStart start, CancellationToken ct = default)
    {
        try
        {
            var settings = await _settingsService.GetSettingsAsync(ct);
            var requestBodyRaw = start.RequestBodyRedacted ?? string.Empty;
            var requestBodyChars = requestBodyRaw.Length;
            var requestBodyMaxChars = LlmLogLimits.GetRequestBodyMaxChars(settings);

            // 先对 JSON 中每个值进行截断（超过 100 字符的值），再整体截断
            var requestBodyTrimmed = TruncateJsonStringValues(requestBodyRaw, maxValueLength: 100);
            var requestBodyStored = Truncate(requestBodyTrimmed, requestBodyMaxChars);
            var requestBodyTruncated = requestBodyChars > requestBodyStored.Length;

            var log = new LlmRequestLog
            {
                Id = Guid.NewGuid().ToString(),
                RequestId = start.RequestId,
                GroupId = start.GroupId,
                SessionId = start.SessionId,
                UserId = start.UserId,
                ViewRole = start.ViewRole,
                RequestType = start.RequestType,
                RequestPurpose = start.RequestPurpose,
                RequestPurposeDisplayName = GetDisplayName(start.RequestPurpose),
                Provider = start.Provider,
                Model = start.Model,
                ApiBase = start.ApiBase,
                Path = start.Path,
                HttpMethod = string.IsNullOrWhiteSpace(start.HttpMethod) ? null : start.HttpMethod.Trim().ToUpperInvariant(),
                PlatformId = start.PlatformId,
                PlatformName = start.PlatformName,
                ModelResolutionType = start.ModelResolutionType,
                ModelGroupId = start.ModelGroupId,
                ModelGroupName = start.ModelGroupName,
                RequestHeadersRedacted = start.RequestHeadersRedacted,
                RequestBodyRedacted = requestBodyStored,
                RequestBodyHash = start.RequestBodyHash ?? Sha256Hex(requestBodyRaw),
                RequestBodyChars = requestBodyChars,
                RequestBodyTruncated = requestBodyTruncated,
                QuestionText = Truncate(start.QuestionText ?? string.Empty, requestBodyMaxChars),
                SystemPromptChars = start.SystemPromptChars,
                SystemPromptHash = start.SystemPromptHash,
                SystemPromptText = string.IsNullOrWhiteSpace(start.SystemPromptText) ? null : Truncate(start.SystemPromptText, requestBodyMaxChars),
                MessageCount = start.MessageCount,
                DocumentChars = start.DocumentChars,
                DocumentHash = start.DocumentHash,
                UserPromptChars = start.UserPromptChars,
                StartedAt = start.StartedAt,
                Status = "running",
                // Exchange 中继信息
                IsExchange = start.IsExchange,
                ExchangeId = start.ExchangeId,
                ExchangeName = start.ExchangeName,
                ExchangeTransformerType = start.ExchangeTransformerType
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
        // 使用默认值（错误信息通常不会太大，使用默认值即可）
        var errorMaxChars = LlmLogLimits.DefaultErrorMaxChars;
        var payload = (Truncate(error, errorMaxChars), statusCode);
        LlmLogQueue.Queue.Writer.TryWrite(new LlmLogOp(LlmLogOpType.MarkError, logId, payload));
    }

    private static string Truncate(string s, int max)
    {
        if (string.IsNullOrEmpty(s)) return s;
        if (s.Length <= max) return s;
        return s[..max] + "...[TRUNCATED]";
    }

    /// <summary>
    /// 截断 JSON 字符串中超过指定长度的值（两个双引号之间的内容）
    /// 不做 JSON 反序列化，直接用正则匹配处理
    /// </summary>
    /// <param name="json">原始 JSON 字符串</param>
    /// <param name="maxValueLength">每个值的最大字符数（默认 100）</param>
    /// <returns>截断后的 JSON 字符串</returns>
    private static string TruncateJsonStringValues(string json, int maxValueLength = 100)
    {
        if (string.IsNullOrEmpty(json)) return json;
        if (maxValueLength <= 0) return json;

        // 匹配 JSON 字符串值："..."
        // 需要处理转义字符，如 \" 不应该被当作结束引号
        // 正则：匹配双引号开始，然后是非双引号或转义序列的字符，最后是双引号结束
        var pattern = @"""((?:[^""\\]|\\.)*)""";

        return Regex.Replace(json, pattern, match =>
        {
            var fullMatch = match.Value;      // 包含引号的完整匹配
            var content = match.Groups[1].Value; // 引号内的内容

            // 如果内容长度超过限制，截断并添加标记
            if (content.Length > maxValueLength)
            {
                // 截取前 maxValueLength 个字符，注意要处理可能截断转义序列的情况
                var truncated = SafeTruncateJsonString(content, maxValueLength);
                return $"\"{truncated}...[{content.Length - maxValueLength} chars trimmed]\"";
            }

            return fullMatch;
        });
    }

    /// <summary>
    /// 安全截断 JSON 字符串内容，避免截断转义序列
    /// </summary>
    private static string SafeTruncateJsonString(string content, int maxLength)
    {
        if (content.Length <= maxLength) return content;

        var result = content[..maxLength];

        // 如果以反斜杠结尾，可能截断了转义序列，回退一个字符
        if (result.EndsWith('\\'))
        {
            result = result[..^1];
        }

        return result;
    }

    private static string Sha256Hex(string input)
    {
        var bytes = Encoding.UTF8.GetBytes(input ?? string.Empty);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    /// <summary>
    /// 从 AppCallerRegistry 获取 AppCallerCode 的中文显示名
    /// </summary>
    private static string? GetDisplayName(string? requestPurpose)
    {
        if (string.IsNullOrWhiteSpace(requestPurpose)) return null;
        var def = AppCallerRegistrationService.FindByAppCode(requestPurpose);
        return def?.DisplayName;
    }
}

