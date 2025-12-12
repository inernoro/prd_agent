using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 用户服务接口
/// </summary>
public interface IUserService
{
    /// <summary>用户注册</summary>
    Task<User> RegisterAsync(string username, string password, string inviteCode, UserRole role, string? displayName = null);
    
    /// <summary>用户登录</summary>
    Task<User?> ValidateCredentialsAsync(string username, string password);
    
    /// <summary>根据ID获取用户</summary>
    Task<User?> GetByIdAsync(string userId);
    
    /// <summary>根据用户名获取用户</summary>
    Task<User?> GetByUsernameAsync(string username);
    
    /// <summary>更新最后登录时间</summary>
    Task UpdateLastLoginAsync(string userId);
    
    /// <summary>验证邀请码</summary>
    Task<bool> ValidateInviteCodeAsync(string inviteCode);
    
    /// <summary>创建邀请码</summary>
    Task<string> CreateInviteCodeAsync(string creatorId);
}
