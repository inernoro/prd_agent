using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 在线状态服务接口
/// </summary>
public interface IOnlineStatusService
{
    /// <summary>标记用户上线</summary>
    Task SetOnlineAsync(string userId, string groupId);

    /// <summary>标记用户下线</summary>
    Task SetOfflineAsync(string userId, string groupId);

    /// <summary>刷新用户心跳</summary>
    Task RefreshHeartbeatAsync(string userId, string groupId);

    /// <summary>获取群组在线成员</summary>
    Task<List<OnlineMember>> GetOnlineMembersAsync(string groupId);

    /// <summary>检查用户是否在线</summary>
    Task<bool> IsOnlineAsync(string userId, string groupId);
}

/// <summary>
/// 在线成员信息
/// </summary>
public class OnlineMember
{
    public string UserId { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public UserRole Role { get; set; }
    public DateTime LastActiveAt { get; set; }
}



