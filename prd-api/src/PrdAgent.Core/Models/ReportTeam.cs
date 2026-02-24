namespace PrdAgent.Core.Models;

/// <summary>
/// 周报团队
/// </summary>
public class ReportTeam
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>团队名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>上级团队 ID（null 表示顶级团队）</summary>
    public string? ParentTeamId { get; set; }

    /// <summary>团队负责人 UserId</summary>
    public string LeaderUserId { get; set; } = string.Empty;

    /// <summary>负责人名称（冗余，便于展示）</summary>
    public string? LeaderName { get; set; }

    /// <summary>团队描述</summary>
    public string? Description { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 周报团队成员
/// </summary>
public class ReportTeamMember
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属团队 ID</summary>
    public string TeamId { get; set; } = string.Empty;

    /// <summary>用户 ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>用户名称（冗余，便于展示）</summary>
    public string? UserName { get; set; }

    /// <summary>用户头像文件名（冗余）</summary>
    public string? AvatarFileName { get; set; }

    /// <summary>角色：member / leader / deputy</summary>
    public string Role { get; set; } = ReportTeamRole.Member;

    /// <summary>岗位名称</summary>
    public string? JobTitle { get; set; }

    /// <summary>加入时间</summary>
    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 团队角色常量
/// </summary>
public static class ReportTeamRole
{
    public const string Member = "member";
    public const string Leader = "leader";
    public const string Deputy = "deputy";

    public static readonly string[] All = { Member, Leader, Deputy };
}
