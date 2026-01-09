namespace PrdAgent.Core.Interfaces;

public record GroupContextCompressionInfo(
    bool Applied,
    string? GroupId,
    long? FromSeq,
    long? ToSeq,
    int? OriginalChars,
    int? CompressedChars,
    string? CompressedText);

public record LlmRequestContext(
    string RequestId,
    string? GroupId,
    string? SessionId,
    string? UserId,
    string? ViewRole,
    int? DocumentChars,
    string? DocumentHash,
    string? SystemPromptRedacted,
    string? RequestType = null,
    string? RequestPurpose = null,
    string? PlatformId = null,
    string? PlatformName = null,
    GroupContextCompressionInfo? GroupContextCompression = null);

public interface ILLMRequestContextAccessor
{
    LlmRequestContext? Current { get; }
    IDisposable BeginScope(LlmRequestContext context);
}

