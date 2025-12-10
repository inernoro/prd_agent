using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 在线状态服务实现
/// </summary>
public class OnlineStatusService : IOnlineStatusService
{
    private readonly ICacheManager _cache;
    private readonly IUserService _userService;
    private const string OnlineKeyPrefix = "online:group:";
    private static readonly TimeSpan OnlineExpiry = TimeSpan.FromMinutes(5);

    public OnlineStatusService(ICacheManager cache, IUserService userService)
    {
        _cache = cache;
        _userService = userService;
    }

    public async Task SetOnlineAsync(string userId, string groupId)
    {
        var key = $"{OnlineKeyPrefix}{groupId}";
        var onlineUsers = await _cache.GetAsync<Dictionary<string, DateTime>>(key) 
            ?? new Dictionary<string, DateTime>();

        onlineUsers[userId] = DateTime.UtcNow;
        await _cache.SetAsync(key, onlineUsers, OnlineExpiry);
    }

    public async Task SetOfflineAsync(string userId, string groupId)
    {
        var key = $"{OnlineKeyPrefix}{groupId}";
        var onlineUsers = await _cache.GetAsync<Dictionary<string, DateTime>>(key);

        if (onlineUsers != null && onlineUsers.ContainsKey(userId))
        {
            onlineUsers.Remove(userId);
            await _cache.SetAsync(key, onlineUsers, OnlineExpiry);
        }
    }

    public async Task RefreshHeartbeatAsync(string userId, string groupId)
    {
        await SetOnlineAsync(userId, groupId);
    }

    public async Task<List<OnlineMember>> GetOnlineMembersAsync(string groupId)
    {
        var key = $"{OnlineKeyPrefix}{groupId}";
        var onlineUsers = await _cache.GetAsync<Dictionary<string, DateTime>>(key);

        if (onlineUsers == null || onlineUsers.Count == 0)
            return new List<OnlineMember>();

        var now = DateTime.UtcNow;
        var activeUsers = onlineUsers
            .Where(kv => now - kv.Value < OnlineExpiry)
            .ToList();

        var members = new List<OnlineMember>();
        foreach (var kv in activeUsers)
        {
            var user = await _userService.GetByIdAsync(kv.Key);
            if (user != null)
            {
                members.Add(new OnlineMember
                {
                    UserId = user.UserId,
                    DisplayName = user.DisplayName,
                    Role = user.Role,
                    LastActiveAt = kv.Value
                });
            }
        }

        return members;
    }

    public async Task<bool> IsOnlineAsync(string userId, string groupId)
    {
        var key = $"{OnlineKeyPrefix}{groupId}";
        var onlineUsers = await _cache.GetAsync<Dictionary<string, DateTime>>(key);

        if (onlineUsers == null || !onlineUsers.TryGetValue(userId, out var lastActive))
            return false;

        return DateTime.UtcNow - lastActive < OnlineExpiry;
    }
}

