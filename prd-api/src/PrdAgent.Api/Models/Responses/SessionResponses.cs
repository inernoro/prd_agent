using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Responses;

/// <summary>
/// 会话信息响应
/// </summary>
public class SessionResponse
{
    public string SessionId { get; set; } = string.Empty;
    public string? GroupId { get; set; }
    public string DocumentId { get; set; } = string.Empty;
    public UserRole CurrentRole { get; set; }
    public InteractionMode Mode { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime LastActiveAt { get; set; }
}

/// <summary>
/// 切换角色响应
/// </summary>
public class SwitchRoleResponse
{
    public string SessionId { get; set; } = string.Empty;
    public UserRole CurrentRole { get; set; }
}

// 引导讲解相关响应已删除（去阶段化）
