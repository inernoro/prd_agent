using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 会话服务接口
/// </summary>
public interface ISessionService
{
    /// <summary>创建会话</summary>
    Task<Session> CreateAsync(string documentId, string? groupId = null);
    
    /// <summary>获取会话</summary>
    Task<Session?> GetByIdAsync(string sessionId);
    
    /// <summary>更新会话</summary>
    Task<Session> UpdateAsync(Session session);
    
    /// <summary>切换角色</summary>
    Task<Session> SwitchRoleAsync(string sessionId, UserRole role);
    
    /// <summary>切换模式</summary>
    Task<Session> SwitchModeAsync(string sessionId, InteractionMode mode);
    
    /// <summary>刷新会话活跃时间</summary>
    Task RefreshActivityAsync(string sessionId);
    
    /// <summary>删除会话</summary>
    Task DeleteAsync(string sessionId);
    
    /// <summary>清理过期会话</summary>
    Task CleanupExpiredSessionsAsync();
}



