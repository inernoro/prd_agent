namespace PrdAgent.Api.Json;

/// <summary>
/// 管理后台：提示词优化流式事件
/// </summary>
public class PromptStageOptimizeStreamEvent
{
    /// <summary>start/delta/done/error</summary>
    public string Type { get; set; } = string.Empty;

    public string? Content { get; set; }

    public string? ErrorCode { get; set; }

    public string? ErrorMessage { get; set; }
}


