namespace PrdAgent.Core.Models;

/// <summary>
/// 会话实体
/// </summary>
public class Session
{
    /// <summary>会话唯一标识（通过 IIdGenerator 生成）</summary>
    public string SessionId { get; set; } = string.Empty;
    
    /// <summary>关联的群组ID（可为空表示个人会话）</summary>
    public string? GroupId { get; set; }

    /// <summary>
    /// 会话归属用户ID（个人/临时会话使用；群组会话为空，由 groupId 做隔离）。
    /// </summary>
    public string? OwnerUserId { get; set; }
    
    /// <summary>关联的文档ID</summary>
    public string DocumentId { get; set; } = string.Empty;

    /// <summary>会话标题（可选：用于 IM 形态的会话列表展示）</summary>
    public string? Title { get; set; }
    
    /// <summary>当前角色视角</summary>
    public UserRole CurrentRole { get; set; } = UserRole.PM;
    
    /// <summary>交互模式</summary>
    public InteractionMode Mode { get; set; } = InteractionMode.QA;
    
    /// <summary>引导模式当前步骤</summary>
    public int? GuideStep { get; set; }
    
    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    /// <summary>最后活跃时间</summary>
    public DateTime LastActiveAt { get; set; } = DateTime.UtcNow;

    /// <summary>归档时间（UTC；非空表示会话已归档）</summary>
    public DateTime? ArchivedAtUtc { get; set; }

    /// <summary>删除时间（UTC；非空表示会话已软删除）</summary>
    public DateTime? DeletedAtUtc { get; set; }
}
