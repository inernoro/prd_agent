using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// PRD 预览页“本章提问”（仅会话内流式返回，不落库）
/// </summary>
public interface IPreviewAskService
{
    IAsyncEnumerable<PreviewAskStreamEvent> AskInSectionAsync(
        string sessionId,
        string headingId,
        string? headingTitle,
        string question,
        UserRole? answerAsRole = null,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// 预览提问流式事件
/// </summary>
public class PreviewAskStreamEvent
{
    public string Type { get; set; } = string.Empty; // start, delta, done, error
    public string? RequestId { get; set; }
    public string? Content { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
}

