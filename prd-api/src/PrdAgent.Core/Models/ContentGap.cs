namespace PrdAgent.Core.Models;

/// <summary>
/// 内容缺失记录
/// </summary>
public class ContentGap
{
    /// <summary>缺失记录唯一标识（通过 IIdGenerator 生成）</summary>
    public string GapId { get; set; } = string.Empty;
    
    /// <summary>所属群组ID</summary>
    public string GroupId { get; set; } = string.Empty;
    
    /// <summary>提问者用户ID</summary>
    public string AskedByUserId { get; set; } = string.Empty;
    
    /// <summary>触发缺失检测的问题</summary>
    public string Question { get; set; } = string.Empty;
    
    /// <summary>缺失类型</summary>
    public GapType GapType { get; set; } = GapType.Other;
    
    /// <summary>处理状态</summary>
    public GapStatus Status { get; set; } = GapStatus.Pending;
    
    /// <summary>AI建议补充的方向</summary>
    public string? Suggestion { get; set; }
    
    /// <summary>提问时间</summary>
    public DateTime AskedAt { get; set; } = DateTime.UtcNow;
    
    /// <summary>处理时间</summary>
    public DateTime? ResolvedAt { get; set; }
}
