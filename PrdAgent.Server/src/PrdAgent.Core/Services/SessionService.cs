using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Cache;

namespace PrdAgent.Core.Services;

/// <summary>
/// 会话服务实现
/// </summary>
public class SessionService : ISessionService
{
    private readonly RedisCacheManager _cache;
    private readonly TimeSpan _sessionTimeout;

    public SessionService(RedisCacheManager cache, int timeoutMinutes = 30)
    {
        _cache = cache;
        _sessionTimeout = TimeSpan.FromMinutes(timeoutMinutes);
    }

    public async Task<Session> CreateAsync(string documentId, string? groupId = null)
    {
        var session = new Session
        {
            DocumentId = documentId,
            GroupId = groupId,
            CurrentRole = UserRole.PM,
            Mode = InteractionMode.QA
        };

        await SaveSessionAsync(session);
        return session;
    }

    public async Task<Session?> GetByIdAsync(string sessionId)
    {
        var key = CacheKeys.ForSession(sessionId);
        return await _cache.GetAsync<Session>(key);
    }

    public async Task<Session> UpdateAsync(Session session)
    {
        session.LastActiveAt = DateTime.UtcNow;
        await SaveSessionAsync(session);
        return session;
    }

    public async Task<Session> SwitchRoleAsync(string sessionId, UserRole role)
    {
        var session = await GetByIdAsync(sessionId)
            ?? throw new KeyNotFoundException("会话不存在");

        session.CurrentRole = role;
        session.LastActiveAt = DateTime.UtcNow;
        await SaveSessionAsync(session);
        
        return session;
    }

    public async Task<Session> SwitchModeAsync(string sessionId, InteractionMode mode)
    {
        var session = await GetByIdAsync(sessionId)
            ?? throw new KeyNotFoundException("会话不存在");

        session.Mode = mode;
        session.LastActiveAt = DateTime.UtcNow;
        
        if (mode == InteractionMode.Guided)
        {
            session.GuideStep = 1;
        }
        else
        {
            session.GuideStep = null;
        }
        
        await SaveSessionAsync(session);
        return session;
    }

    public async Task RefreshActivityAsync(string sessionId)
    {
        var session = await GetByIdAsync(sessionId);
        if (session != null)
        {
            session.LastActiveAt = DateTime.UtcNow;
            await SaveSessionAsync(session);
        }
    }

    public async Task DeleteAsync(string sessionId)
    {
        var sessionKey = CacheKeys.ForSession(sessionId);
        var historyKey = CacheKeys.ForChatHistory(sessionId);
        
        await _cache.RemoveAsync(sessionKey);
        await _cache.RemoveAsync(historyKey);
    }

    public async Task CleanupExpiredSessionsAsync()
    {
        // 获取所有会话键
        var keys = _cache.GetKeys($"{CacheKeys.Session}*");
        
        foreach (var key in keys)
        {
            var session = await _cache.GetAsync<Session>(key);
            if (session != null && 
                DateTime.UtcNow - session.LastActiveAt > _sessionTimeout)
            {
                await DeleteAsync(session.SessionId);
            }
        }
    }

    private async Task SaveSessionAsync(Session session)
    {
        var key = CacheKeys.ForSession(session.SessionId);
        await _cache.SetAsync(key, session, _sessionTimeout);
    }
}

