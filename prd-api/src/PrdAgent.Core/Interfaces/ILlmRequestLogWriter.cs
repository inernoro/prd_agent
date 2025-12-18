using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public record LlmLogStart(
    string RequestId,
    string Provider,
    string Model,
    string? ApiBase,
    string? Path,
    Dictionary<string, string>? RequestHeadersRedacted,
    string RequestBodyRedacted,
    string? RequestBodyHash,
    string? QuestionText,
    int? SystemPromptChars,
    string? SystemPromptHash,
    int? MessageCount,
    string? GroupId,
    string? SessionId,
    string? UserId,
    string? ViewRole,
    int? DocumentChars,
    string? DocumentHash,
    DateTime StartedAt);

public record LlmLogDone(
    int? StatusCode,
    Dictionary<string, string>? ResponseHeaders,
    int? InputTokens,
    int? OutputTokens,
    int? CacheCreationInputTokens,
    int? CacheReadInputTokens,
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

