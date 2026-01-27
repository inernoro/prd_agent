using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 群组实体
/// </summary>
[AppOwnership(AppNames.PrdAgent, AppNames.PrdAgentDisplay, IsPrimary = true)]
public class Group
{
    /// <summary>群组唯一标识（通过 IIdGenerator 生成）</summary>
    public string GroupId { get; set; } = string.Empty;
    
    /// <summary>群组名称</summary>
    public string GroupName { get; set; } = string.Empty;
    
    /// <summary>群主用户ID</summary>
    public string OwnerId { get; set; } = string.Empty;
    
    /// <summary>绑定的PRD文档ID</summary>
    public string PrdDocumentId { get; set; } = string.Empty;

    /// <summary>PRD标题快照（仅元数据；不存原文）</summary>
    public string? PrdTitleSnapshot { get; set; }

    /// <summary>PRD Token 估算快照（可选，仅元数据）</summary>
    public int? PrdTokenEstimateSnapshot { get; set; }

    /// <summary>PRD 字符数快照（可选，仅元数据）</summary>
    public int? PrdCharCountSnapshot { get; set; }
    
    /// <summary>邀请码</summary>
    public string InviteCode { get; set; } = GenerateInviteCode();
    
    /// <summary>邀请码过期时间（null表示永不过期）</summary>
    public DateTime? InviteExpireAt { get; set; }
    
    /// <summary>最大成员数</summary>
    public int MaxMembers { get; set; } = 20;
    
    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    private static string GenerateInviteCode()
    {
        return $"INV-{Guid.NewGuid().ToString("N")[..8].ToUpper()}";
    }
}

/// <summary>
/// 群组成员
/// </summary>
[AppOwnership(AppNames.PrdAgent, AppNames.PrdAgentDisplay, IsPrimary = true)]
public class GroupMember
{
    /// <summary>成员记录ID</summary>
    public string? Id { get; set; }
    
    /// <summary>群组ID</summary>
    public string GroupId { get; set; } = string.Empty;
    
    /// <summary>用户ID</summary>
    public string UserId { get; set; } = string.Empty;
    
    /// <summary>成员在群组中的角色</summary>
    public UserRole MemberRole { get; set; } = UserRole.DEV;

    /// <summary>
    /// 群内成员标签（用于展示与权限/能力路由；与 UserRole 不冲突，可多标签）
    /// 约定示例：
    /// - 机器人：[{name:"机器人", role:"robot"},{name:"产品经理", role:"pm"}]
    /// - 人类：[{name:"产品经理", role:"pm"}]
    /// </summary>
    public List<GroupMemberTag> Tags { get; set; } = new();
    
    /// <summary>加入时间</summary>
    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 群内成员标签
/// </summary>
public class GroupMemberTag
{
    /// <summary>展示名称（中文）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>机器可读的 role（建议小写：robot/pm/dev/qa/owner/admin 等）</summary>
    public string Role { get; set; } = string.Empty;
}
