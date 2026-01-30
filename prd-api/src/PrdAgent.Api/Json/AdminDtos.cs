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
    /// <summary>用户类型：Human/Bot</summary>
    public string UserType { get; set; } = string.Empty;
    /// <summary>机器人类型（仅当 UserType=Bot 时有值）：PM/DEV/QA</summary>
    public string? BotKind { get; set; }
    /// <summary>头像文件名（仅文件名，不含路径/域名）</summary>
    public string? AvatarFileName { get; set; }
    /// <summary>头像可直接渲染的 URL（服务端拼好）</summary>
    public string? AvatarUrl { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? LastLoginAt { get; set; }
    public DateTime? LastActiveAt { get; set; }
    /// <summary>是否处于登录锁定期（由 LoginAttemptService 动态计算）</summary>
    public bool IsLocked { get; set; }
    /// <summary>剩余锁定秒数（0 表示未锁定）</summary>
    public int LockoutRemainingSeconds { get; set; }
    /// <summary>系统角色 key（用于权限管理）</summary>
    public string? SystemRoleKey { get; set; }
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
    /// <summary>用户类型：Human/Bot</summary>
    public string UserType { get; set; } = string.Empty;
    /// <summary>机器人类型（仅当 UserType=Bot 时有值）：PM/DEV/QA</summary>
    public string? BotKind { get; set; }
    /// <summary>头像文件名（仅文件名，不含路径/域名）</summary>
    public string? AvatarFileName { get; set; }
    /// <summary>头像可直接渲染的 URL（服务端拼好）</summary>
    public string? AvatarUrl { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? LastLoginAt { get; set; }
    public DateTime? LastActiveAt { get; set; }
    public bool IsLocked { get; set; }
    public int LockoutRemainingSeconds { get; set; }
}

/// <summary>
/// 用户简要资料响应（用于卡片悬浮展示）
/// </summary>
public class UserProfileResponse
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public string UserType { get; set; } = string.Empty;
    public string? BotKind { get; set; }
    public string? AvatarFileName { get; set; }
    public string? AvatarUrl { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? LastLoginAt { get; set; }
    public DateTime? LastActiveAt { get; set; }
    public bool IsLocked { get; set; }
    /// <summary>用户加入的群组列表</summary>
    public List<UserProfileGroupItem> Groups { get; set; } = new();
    /// <summary>用户使用的 Agent 统计（最近30天）</summary>
    public List<UserProfileAgentUsageItem> AgentUsage { get; set; } = new();
    /// <summary>生成的图片总数（最近30天）</summary>
    public int TotalImageCount { get; set; }
    /// <summary>生图任务总数（最近30天）</summary>
    public int TotalRunCount { get; set; }
    /// <summary>缺陷统计（最近30天）</summary>
    public UserProfileDefectStats? DefectStats { get; set; }
}

/// <summary>
/// 用户简要资料 - 群组项
/// </summary>
public class UserProfileGroupItem
{
    public string GroupId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public int MemberCount { get; set; }
}

/// <summary>
/// 用户简要资料 - Agent 使用统计项
/// </summary>
public class UserProfileAgentUsageItem
{
    public string AppKey { get; set; } = string.Empty;
    public int UsageCount { get; set; }
}

/// <summary>
/// 用户简要资料 - 缺陷统计项
/// </summary>
public class UserProfileDefectStats
{
    /// <summary>收到的缺陷数（被指派给我的）</summary>
    public int ReceivedCount { get; set; }
    /// <summary>提交的缺陷数（我报告的）</summary>
    public int SubmittedCount { get; set; }
}

/// <summary>
/// 用户头像更新响应
/// </summary>
public class UserAvatarUpdateResponse
{
    public string UserId { get; set; } = string.Empty;
    public string? AvatarFileName { get; set; }
    public DateTime UpdatedAt { get; set; }
}

/// <summary>
/// 用户头像上传响应（上传文件并更新 users.avatarFileName 后返回）
/// </summary>
public class UserAvatarUploadResponse
{
    public string UserId { get; set; } = string.Empty;
    public string? AvatarFileName { get; set; }
    public string? AvatarUrl { get; set; }
    public DateTime UpdatedAt { get; set; }
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
/// 用户显示名称更新响应
/// </summary>
public class UserDisplayNameUpdateResponse
{
    public string UserId { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
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
/// 初始化用户响应
/// </summary>
public class InitializeUsersResponse
{
    public long DeletedCount { get; set; }
    public string AdminUserId { get; set; } = string.Empty;
    public List<string> BotUserIds { get; set; } = new();
}

/// <summary>
/// 管理端创建用户响应
/// </summary>
public class AdminCreateUserResponse
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
}

/// <summary>
/// 批量创建用户响应
/// </summary>
public class AdminBulkCreateUsersResponse
{
    public int RequestedCount { get; set; }
    public int CreatedCount { get; set; }
    public int FailedCount { get; set; }
    public List<AdminCreateUserResponse> CreatedItems { get; set; } = new();
    public List<AdminBulkCreateUserError> FailedItems { get; set; } = new();
}

/// <summary>
/// 批量创建用户 - 失败项
/// </summary>
public class AdminBulkCreateUserError
{
    public string Username { get; set; } = string.Empty;
    public string Code { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
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

