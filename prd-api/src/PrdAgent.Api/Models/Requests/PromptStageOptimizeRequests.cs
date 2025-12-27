using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 管理后台：阶段提示词优化（流式）
/// </summary>
public class PromptStageOptimizeStreamRequest
{
    private const int MaxPromptChars = 32 * 1024;

    /// <summary>稳定阶段标识</summary>
    public string? StageKey { get; set; }

    /// <summary>排序号（可选，仅用于上下文）</summary>
    public int? Order { get; set; }

    /// <summary>角色（仅允许 PM/DEV/QA）</summary>
    public UserRole Role { get; set; } = UserRole.PM;

    /// <summary>阶段标题（可选，仅用于上下文）</summary>
    public string? Title { get; set; }

    /// <summary>原始提示词模板</summary>
    public string PromptTemplate { get; set; } = string.Empty;

    /// <summary>优化模式：strict/concise（默认 strict）</summary>
    public string? Mode { get; set; }

    public (bool IsValid, string? ErrorMessage) Validate()
    {
        if (Role is not (UserRole.PM or UserRole.DEV or UserRole.QA))
            return (false, "role 仅支持 PM/DEV/QA");

        var p = (PromptTemplate ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(p))
            return (false, "promptTemplate 不能为空");
        if (p.Length > MaxPromptChars)
            return (false, $"promptTemplate 过长（上限 {MaxPromptChars} 字符）");

        var m = (Mode ?? "strict").Trim().ToLowerInvariant();
        if (m is not ("strict" or "concise"))
            return (false, "mode 仅支持 strict/concise");

        return (true, null);
    }
}


