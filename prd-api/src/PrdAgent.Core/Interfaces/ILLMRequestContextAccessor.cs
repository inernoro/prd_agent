namespace PrdAgent.Core.Interfaces;

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
    string? PlatformName = null);

public interface ILLMRequestContextAccessor
{
    LlmRequestContext? Current { get; }
    IDisposable BeginScope(LlmRequestContext context);
}

