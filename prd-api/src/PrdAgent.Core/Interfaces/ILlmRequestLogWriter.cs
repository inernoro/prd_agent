using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public record LlmLogStart(
    string RequestId,
    string Provider,
    string Model,
    string? ApiBase,
    string? Path,
    string? HttpMethod,
    Dictionary<string, string>? RequestHeadersRedacted,
    string RequestBodyRedacted,
    string? RequestBodyHash,
    string? QuestionText,
    int? SystemPromptChars,
    string? SystemPromptHash,
    string? SystemPromptText,
    int? MessageCount,
    string? GroupId,
    string? SessionId,
    string? UserId,
    string? ViewRole,
    int? DocumentChars,
    string? DocumentHash,
    int? UserPromptChars,
    DateTime StartedAt,
    string? RequestType = null,
    string? RequestPurpose = null,
    string? PlatformId = null,
    string? PlatformName = null,
    /// <summary>模型解析类型（0=直连单模型, 1=默认模型池, 2=专属模型池）</summary>
    ModelResolutionType? ModelResolutionType = null,
    string? ModelGroupId = null,
    string? ModelGroupName = null,
    // Exchange 中继信息
    bool? IsExchange = null,
    string? ExchangeId = null,
    string? ExchangeName = null,
    string? ExchangeTransformerType = null);

public record LlmLogDone(
    int? StatusCode,
    Dictionary<string, string>? ResponseHeaders,
    int? InputTokens,
    int? OutputTokens,
    int? CacheCreationInputTokens,
    int? CacheReadInputTokens,
    string? TokenUsageSource,
    int? ImageSuccessCount,
    string? AnswerText,
    int? AssembledTextChars,
    string? AssembledTextHash,
    string Status,
    DateTime EndedAt,
    long? DurationMs);

public interface ILlmRequestLogWriter
{
    Task<string?> StartAsync(LlmLogStart start, CancellationToken ct = default);
    void MarkFirstByte(string logId, DateTime at);
    void MarkDone(string logId, LlmLogDone done);
    void MarkError(string logId, string error, int? statusCode = null);
}

