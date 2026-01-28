using System.Collections.Concurrent;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 内存限流服务 - Redis 不可用时的 fallback
/// 开发环境默认不限流
/// </summary>
public class MemoryRateLimitService : IRateLimitService
{
    private readonly ConcurrentDictionary<string, bool> _exemptUsers = new();
    private readonly ConcurrentDictionary<string, UserRateLimitConfig> _userConfigs = new();
    private GlobalRateLimitConfig _globalConfig = new();

    public Task<(bool allowed, string? reason)> CheckRequestAsync(string clientId, CancellationToken ct = default)
    {
        // 开发环境：默认允许所有请求
        return Task.FromResult((true, (string?)null));
    }

    public Task RequestCompletedAsync(string clientId, CancellationToken ct = default)
    {
        return Task.CompletedTask;
    }

    public Task<bool> IsExemptAsync(string userId, CancellationToken ct = default)
    {
        return Task.FromResult(_exemptUsers.TryGetValue(userId, out var exempt) && exempt);
    }

    public Task SetExemptAsync(string userId, bool exempt, CancellationToken ct = default)
    {
        if (exempt)
        {
            _exemptUsers[userId] = true;
        }
        else
        {
            _exemptUsers.TryRemove(userId, out _);
        }
        return Task.CompletedTask;
    }

    public Task<UserRateLimitConfig?> GetUserConfigAsync(string userId, CancellationToken ct = default)
    {
        return Task.FromResult(_userConfigs.TryGetValue(userId, out var config) ? config : null);
    }

    public Task SetUserConfigAsync(string userId, UserRateLimitConfig config, CancellationToken ct = default)
    {
        _userConfigs[userId] = config;
        return Task.CompletedTask;
    }

    public Task RemoveUserConfigAsync(string userId, CancellationToken ct = default)
    {
        _userConfigs.TryRemove(userId, out _);
        return Task.CompletedTask;
    }

    public Task<GlobalRateLimitConfig> GetGlobalConfigAsync(CancellationToken ct = default)
    {
        return Task.FromResult(_globalConfig);
    }

    public Task SetGlobalConfigAsync(GlobalRateLimitConfig config, CancellationToken ct = default)
    {
        _globalConfig = config;
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<string>> GetAllExemptUsersAsync(CancellationToken ct = default)
    {
        return Task.FromResult<IReadOnlyList<string>>(_exemptUsers.Keys.ToList());
    }

    public Task<IReadOnlyList<(string userId, UserRateLimitConfig config)>> GetAllUserConfigsAsync(CancellationToken ct = default)
    {
        var result = _userConfigs.Select(kv => (kv.Key, kv.Value)).ToList();
        return Task.FromResult<IReadOnlyList<(string, UserRateLimitConfig)>>(result);
    }
}
