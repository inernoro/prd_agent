using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Responses;

/// <summary>
/// 群组响应
/// </summary>
public class GroupResponse
{
    public string GroupId { get; set; } = string.Empty;
    public string GroupName { get; set; } = string.Empty;
    public string PrdDocumentId { get; set; } = string.Empty;
    public string? PrdTitle { get; set; }
    public string InviteLink { get; set; } = string.Empty;
    public string InviteCode { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public int MemberCount { get; set; }
}

/// <summary>
/// 加入群组响应
/// </summary>
public class JoinGroupResponse
{
    public string GroupId { get; set; } = string.Empty;
    public string GroupName { get; set; } = string.Empty;
    public string? PrdTitle { get; set; }
    public int MemberCount { get; set; }
    public DateTime JoinedAt { get; set; }
}

/// <summary>
/// 群组成员响应
/// </summary>
public class GroupMemberResponse
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public UserRole MemberRole { get; set; }
    public DateTime JoinedAt { get; set; }
    public bool IsOwner { get; set; }
}

