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
    public int? GuideStep { get; set; }
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

/// <summary>
/// 引导控制响应
/// </summary>
public class GuideControlResponse
{
    public int CurrentStep { get; set; }
    public int TotalSteps { get; set; }
    public GuideStatus Status { get; set; }
}
