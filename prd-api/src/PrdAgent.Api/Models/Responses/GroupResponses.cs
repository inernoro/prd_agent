using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Responses;

/// <summary>
/// 群组响应
/// </summary>
public class GroupResponse
{
    public string GroupId { get; set; } = string.Empty;
    public string GroupName { get; set; } = string.Empty;
    public string? PrdDocumentId { get; set; }
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
    public List<GroupMemberTagDto> Tags { get; set; } = new();
    // 兼容字段：前端若仍依赖 isBot/botKind，可继续使用；但推荐迁移到 tags[]
    public bool IsBot { get; set; }
    public BotKind? BotKind { get; set; }
    /// <summary>头像文件名（仅文件名，不含路径/域名）</summary>
    public string? AvatarFileName { get; set; }
    /// <summary>头像可直接渲染的 URL（服务端拼好，便于 desktop 端直接展示）</summary>
    public string? AvatarUrl { get; set; }
    public DateTime JoinedAt { get; set; }
    public bool IsOwner { get; set; }
}

public class GroupMemberTagDto
{
    public string Name { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
}

/// <summary>
/// 打开群组会话响应
/// </summary>
public class OpenGroupSessionResponse
{
    public string SessionId { get; set; } = string.Empty;
    public string GroupId { get; set; } = string.Empty;
    public string DocumentId { get; set; } = string.Empty;
    public UserRole CurrentRole { get; set; }
}
