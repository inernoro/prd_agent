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
    string? PlatformName = null,
    /// <summary>模型解析类型（0=直连单模型, 1=默认模型池, 2=专属模型池）</summary>
    ModelResolutionType? ModelResolutionType = null,
    string? ModelGroupId = null,
    string? ModelGroupName = null);

public interface ILLMRequestContextAccessor
{
    LlmRequestContext? Current { get; }
    IDisposable BeginScope(LlmRequestContext context);
}

