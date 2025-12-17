namespace PrdAgent.Core.Interfaces;

public record LlmRequestContext(
    string RequestId,
    string? GroupId,
    string? SessionId,
    string? UserId,
    string? ViewRole,
    int? DocumentChars,
    string? DocumentHash,
    string? SystemPromptRedacted);

public interface ILLMRequestContextAccessor
{
    LlmRequestContext? Current { get; }
    IDisposable BeginScope(LlmRequestContext context);
}

