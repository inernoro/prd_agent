using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 引导讲解服务接口
/// </summary>
public interface IGuideService
{
    /// <summary>启动引导讲解</summary>
    IAsyncEnumerable<GuideStreamEvent> StartGuideAsync(
        string sessionId, 
        UserRole role,
        CancellationToken cancellationToken = default);
    
    /// <summary>控制引导进度</summary>
    Task<GuideControlResult> ControlAsync(string sessionId, GuideAction action, int? targetStep = null);
    
    /// <summary>获取下一步讲解内容</summary>
    IAsyncEnumerable<GuideStreamEvent> GetStepContentAsync(
        string sessionId, 
        int step,
        CancellationToken cancellationToken = default);
    
    /// <summary>获取角色对应的讲解大纲</summary>
    List<GuideOutlineItem> GetOutline(UserRole role);
}

/// <summary>
/// 引导流式事件
/// </summary>
public class GuideStreamEvent
{
    public string Type { get; set; } = string.Empty; // step, delta, stepDone, error
    public int? Step { get; set; }
    public int? TotalSteps { get; set; }
    public string? Title { get; set; }
    public string? Content { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }

    // Block Protocol（用于稳定的流式 Markdown 渲染）
    // type: blockStart / blockDelta / blockEnd
    public string? BlockId { get; set; }
    public string? BlockKind { get; set; } // paragraph | heading | listItem | codeBlock
    public string? BlockLanguage { get; set; } // codeBlock 可选语言

    /// <summary>
    /// 结构化引用（type=citations 时下发；也可附带在 stepDone 前后事件里）
    /// </summary>
    public List<DocCitation>? Citations { get; set; }
}

/// <summary>
/// 引导控制结果
/// </summary>
public class GuideControlResult
{
    public int CurrentStep { get; set; }
    public int TotalSteps { get; set; }
    public GuideStatus Status { get; set; }
}


