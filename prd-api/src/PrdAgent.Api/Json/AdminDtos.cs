using PrdAgent.Core.Models;

namespace PrdAgent.Api.Json;

/// <summary>
/// 用户列表响应
/// </summary>
public class UserListResponse
{
    public List<UserListItem> Items { get; set; } = new();
    public long Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
}

/// <summary>
/// 用户列表项
/// </summary>
public class UserListItem
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public DateTime? LastLoginAt { get; set; }
    /// <summary>是否处于登录锁定期（由 LoginAttemptService 动态计算）</summary>
    public bool IsLocked { get; set; }
    /// <summary>剩余锁定秒数（0 表示未锁定）</summary>
    public int LockoutRemainingSeconds { get; set; }
}

/// <summary>
/// 用户详情响应
/// </summary>
public class UserDetailResponse
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public DateTime? LastLoginAt { get; set; }
    public bool IsLocked { get; set; }
    public int LockoutRemainingSeconds { get; set; }
}

/// <summary>
/// 用户状态更新响应
/// </summary>
public class UserStatusUpdateResponse
{
    public string UserId { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
}

/// <summary>
/// 用户角色更新响应
/// </summary>
public class UserRoleUpdateResponse
{
    public string UserId { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
}

/// <summary>
/// 用户密码更新响应
/// </summary>
public class UserPasswordUpdateResponse
{
    public string UserId { get; set; } = string.Empty;
    public DateTime UpdatedAt { get; set; }
}

/// <summary>
/// 管理端解锁用户响应
/// </summary>
public class UnlockUserResponse
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public DateTime UnlockedAt { get; set; }
}

/// <summary>
/// 邀请码生成响应
/// </summary>
public class InviteCodeGenerateResponse
{
    public List<string> Codes { get; set; } = new();
}

/// <summary>
/// 健康检查响应
/// </summary>
public class HealthCheckResponse
{
    public string Status { get; set; } = string.Empty;
    public string Version { get; set; } = string.Empty;
    public DateTime Timestamp { get; set; }
}

/// <summary>
/// 流式错误事件
/// </summary>
public class StreamErrorEvent
{
    public string Type { get; set; } = "error";
    public string ErrorCode { get; set; } = string.Empty;
    public string ErrorMessage { get; set; } = string.Empty;
}

