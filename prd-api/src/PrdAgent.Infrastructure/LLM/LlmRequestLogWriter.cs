using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// LLM 请求日志写入器（写入旁路，不影响主流程）\n/// </summary>
public class LlmRequestLogWriter : ILlmRequestLogWriter
{
    private readonly MongoDbContext _db;
    private readonly ILogger<LlmRequestLogWriter> _logger;
    private readonly IAppSettingsService _settingsService;
    private readonly IAssetStorage _assetStorage;

    /// <summary>JSON 中字符串值超过此长度时，上传 COS 存储引用</summary>
    private const int CosTextThreshold = 1024;

    public LlmRequestLogWriter(MongoDbContext db, ILogger<LlmRequestLogWriter> logger, LlmRequestLogBackground _, IAppSettingsService settingsService, IAssetStorage assetStorage)
    {
        _db = db;
        _logger = logger;
        _settingsService = settingsService;
        _assetStorage = assetStorage;
    }

    public async Task<string?> StartAsync(LlmLogStart start, CancellationToken ct = default)
    {
        try
        {
            var settings = await _settingsService.GetSettingsAsync(ct);
            var requestBodyRaw = start.RequestBodyRedacted ?? string.Empty;
            var requestBodyChars = requestBodyRaw.Length;
            var requestBodyMaxChars = LlmLogLimits.GetRequestBodyMaxChars(settings);

            // JSON 字符串值处理：
            //   - base64 data URL → SHA256 摘要引用 [BASE64_IMAGE:sha256:mime]（COS 反查恢复）
            //   - 文本 > 1024 字符 → 上传 COS 存储引用 [TEXT_COS:sha256:charcount]
            //   - 整体大小由 requestBodyMaxChars 兜底
            var requestBodyProcessed = await ProcessJsonStringValuesForCosAsync(requestBodyRaw, ct);
            var requestBodyStored = Truncate(requestBodyProcessed, requestBodyMaxChars);
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
                AppCallerCode = start.AppCallerCode,
                AppCallerCodeDisplayName = GetDisplayName(start.AppCallerCode),
                Provider = start.Provider,
                Model = start.Model,
                ApiBase = start.ApiBase,
                Path = start.Path,
                HttpMethod = string.IsNullOrWhiteSpace(start.HttpMethod) ? null : start.HttpMethod.Trim().ToUpperInvariant(),
                PlatformId = start.PlatformId,
                PlatformName = start.PlatformName,
                Protocol = start.Protocol,
                ResolutionReason = start.ResolutionReason,
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
                ExchangeTransformerType = start.ExchangeTransformerType,
                // 图片引用
                ImageReferences = start.ImageReferences,
                // 模型降级信息
                IsFallback = start.IsFallback,
                FallbackReason = start.FallbackReason,
                ExpectedModel = start.ExpectedModel,
                IsHealthProbe = start.IsHealthProbe,
                IsStreaming = start.IsStreaming
            };

            await _db.LlmRequestLogs.InsertOneAsync(log, cancellationToken: ct);

            // 运行时警告：UserId 为空意味着日志无法关联到用户
            if (string.IsNullOrWhiteSpace(log.UserId))
            {
                _logger.LogWarning(
                    "[LlmLog] UserId 为空，请检查调用方是否设置了 LlmRequestContext 或 GatewayRequestContext。" +
                    " AppCallerCode={AppCallerCode}, RequestId={RequestId}",
                    log.AppCallerCode, log.RequestId);
            }

            return log.Id;
        }
        catch (Exception ex)
        {
            // 黑洞可见：StartAsync 失败（多半是 COS 上传 / requestBody 处理炸了）会导致
            // LLM 调用完全不落日志——用户看到功能跑通但日志页空空，对运维而言是幽灵级别故障。
            // 这里尽力插入一条「最小记录」（Status=blackhole），让"记录降级"也可在日志页查到，
            // 而不是只在 container logs 里留一条 Warning。最小记录只用 start 上的原始字段，
            // 不再走可能失败的 COS 处理路径，避免二次抛异常。
            //
            // 语义校正（修复「blackhole 误标成功调用」）：StartAsync 在请求**发起前**被调用，
            // 此处失败的是「日志写入」而非「请求发送」——请求随后仍会照常发起（上层吞掉日志异常）。
            // 故 blackhole 的准确含义是「本次请求的完整生命周期未能可靠记录」，既非"成功"也非"未发出"。
            // 为保证这条故障可见、不被后续 MarkDone/MarkError 覆盖或反向误标，这里**返回 null**：
            // 上层 logId 保持 null → 所有 Mark* 调用 no-op（受 logId==null 守卫），blackhole 占位记录
            // 作为独立、不可变的「记录降级」标记留存。不再依赖 LlmRequestLogBackground 的 Status 过滤兜底。
            try
            {
                var fallbackLog = new LlmRequestLog
                {
                    Id = Guid.NewGuid().ToString(),
                    RequestId = start.RequestId,
                    GroupId = start.GroupId,
                    SessionId = start.SessionId,
                    UserId = start.UserId,
                    ViewRole = start.ViewRole,
                    RequestType = start.RequestType,
                    AppCallerCode = start.AppCallerCode,
                    AppCallerCodeDisplayName = GetDisplayName(start.AppCallerCode),
                    Provider = start.Provider,
                    Model = start.Model,
                    StartedAt = start.StartedAt == default ? DateTime.UtcNow : start.StartedAt,
                    EndedAt = DateTime.UtcNow,
                    Status = "blackhole",
                    Error = $"日志写入失败（请求仍照常发起，但完整结果未被记录）：{ex.GetType().Name}: {ex.Message}"
                };
                await _db.LlmRequestLogs.InsertOneAsync(fallbackLog, cancellationToken: ct);
                _logger.LogWarning(ex, "LlmRequestLogWriter.StartAsync failed — 已写入 blackhole 占位日志（记录降级）。AppCallerCode={AppCallerCode}, RequestId={RequestId}", start.AppCallerCode, start.RequestId);
                // 关键：返回 null 而非 fallbackLog.Id，使后续 MarkDone/MarkError 不会复用并覆盖这条记录。
                return null;
            }
            catch (Exception fallbackEx)
            {
                // 连最小记录都写不进去（DB 不可用），只能降级到 Warning 日志兜底。
                _logger.LogWarning(fallbackEx, "LlmRequestLogWriter.StartAsync failed 且 blackhole 占位日志也写入失败 — LLM 调用不会被记录。AppCallerCode={AppCallerCode}。原始异常：{OriginalError}", start.AppCallerCode, ex.Message);
                return null;
            }
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
    /// 异步处理 JSON 字符串值：
    ///   - base64 data URL → SHA256 摘要引用 [BASE64_IMAGE:sha256:mime]
    ///   - 文本 > CosTextThreshold → 上传 COS，替换为 [TEXT_COS:sha256:charcount]
    ///   - 短文本保持不变
    /// 不做 JSON 反序列化，直接用正则匹配处理。
    /// </summary>
    private async Task<string> ProcessJsonStringValuesForCosAsync(string json, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(json)) return json;

        // 匹配 JSON 字符串值："..."（处理转义字符）
        var pattern = @"""((?:[^""\\]|\\.)*)""";
        var matches = Regex.Matches(json, pattern);
        if (matches.Count == 0) return json;

        // 收集需要替换的匹配项（逆序替换避免偏移）
        var replacements = new List<(int index, int length, string replacement)>();

        foreach (Match match in matches)
        {
            var content = match.Groups[1].Value;
            if (content.Length <= CosTextThreshold) continue;

            // base64 data URL → SHA256 摘要引用（不上传 COS，图片已由原始上传流程存入）
            if (TryExtractBase64DataUrlSha256(content, out var imgSha256, out var mime))
            {
                replacements.Add((match.Index, match.Length, $"\"[BASE64_IMAGE:{imgSha256}:{mime}]\""));
                continue;
            }

            // 长文本 → 上传 COS → [TEXT_COS:sha256:charcount]
            try
            {
                var textBytes = Encoding.UTF8.GetBytes(content);
                var stored = await _assetStorage.SaveAsync(textBytes, "text/plain", ct,
                    domain: AppDomainPaths.DomainLogs, type: AppDomainPaths.TypeLog);
                replacements.Add((match.Index, match.Length, $"\"[TEXT_COS:{stored.Sha256}:{content.Length}]\""));
            }
            catch (Exception ex)
            {
                // COS 上传失败，降级为截断
                _logger.LogWarning(ex, "COS text upload failed, falling back to truncation");
                var truncated = SafeTruncateJsonString(content, CosTextThreshold);
                replacements.Add((match.Index, match.Length, $"\"{truncated}...[{content.Length - CosTextThreshold} chars trimmed]\""));
            }
        }

        if (replacements.Count == 0) return json;

        // 逆序替换（从后向前避免偏移问题）
        var sb = new StringBuilder(json);
        foreach (var (index, length, replacement) in replacements.OrderByDescending(r => r.index))
        {
            sb.Remove(index, length);
            sb.Insert(index, replacement);
        }

        return sb.ToString();
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

    /// <summary>
    /// 检测并提取 base64 data URL 的 SHA256 摘要（用于 COS 图片反查）。
    /// 匹配格式: data:image/xxx;base64,<base64_data>
    /// 返回原始字节的 SHA256 + MIME 类型，供 replay-curl 从 COS 恢复完整图片。
    /// </summary>
    private static bool TryExtractBase64DataUrlSha256(string content, out string sha256Hex, out string mime)
    {
        sha256Hex = string.Empty;
        mime = "image/png";

        const string dataPrefix = "data:";
        const string base64Marker = ";base64,";

        if (!content.StartsWith(dataPrefix, StringComparison.OrdinalIgnoreCase))
            return false;

        var markerIdx = content.IndexOf(base64Marker, StringComparison.OrdinalIgnoreCase);
        if (markerIdx < 0) return false;

        mime = content[dataPrefix.Length..markerIdx];
        var base64Data = content[(markerIdx + base64Marker.Length)..];

        if (string.IsNullOrWhiteSpace(base64Data)) return false;

        try
        {
            var bytes = Convert.FromBase64String(base64Data);
            var hash = SHA256.HashData(bytes);
            sha256Hex = Convert.ToHexString(hash).ToLowerInvariant();
            return true;
        }
        catch
        {
            return false;
        }
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

