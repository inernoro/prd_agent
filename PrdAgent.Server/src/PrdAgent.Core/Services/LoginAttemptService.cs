using PrdAgent.Core.Interfaces;

namespace PrdAgent.Core.Services;

/// <summary>
/// 登录尝试服务实现
/// </summary>
public class LoginAttemptService : ILoginAttemptService
{
    private readonly ICacheManager _cache;
    private readonly int _maxAttempts;
    private readonly TimeSpan _lockoutDuration;
    private readonly TimeSpan _attemptWindow;

    private const string AttemptKeyPrefix = "login:attempt:";
    private const string LockoutKeyPrefix = "login:lockout:";

    public LoginAttemptService(
        ICacheManager cache,
        int maxAttempts = 5,
        int lockoutMinutes = 15,
        int attemptWindowMinutes = 30)
    {
        _cache = cache;
        _maxAttempts = maxAttempts;
        _lockoutDuration = TimeSpan.FromMinutes(lockoutMinutes);
        _attemptWindow = TimeSpan.FromMinutes(attemptWindowMinutes);
    }

    public async Task<bool> IsLockedAsync(string username)
    {
        var lockoutKey = $"{LockoutKeyPrefix}{username.ToLowerInvariant()}";
        return await _cache.ExistsAsync(lockoutKey);
    }

    public async Task RecordFailedAttemptAsync(string username)
    {
        var normalizedUsername = username.ToLowerInvariant();
        var attemptKey = $"{AttemptKeyPrefix}{normalizedUsername}";
        var lockoutKey = $"{LockoutKeyPrefix}{normalizedUsername}";

        // 获取当前失败次数
        var attempts = await _cache.GetAsync<int>(attemptKey);
        attempts++;

        if (attempts >= _maxAttempts)
        {
            // 锁定账户
            await _cache.SetAsync(lockoutKey, DateTime.UtcNow, _lockoutDuration);
            await _cache.RemoveAsync(attemptKey);
        }
        else
        {
            // 更新失败次数
            await _cache.SetAsync(attemptKey, attempts, _attemptWindow);
        }
    }

    public async Task ResetAttemptsAsync(string username)
    {
        var normalizedUsername = username.ToLowerInvariant();
        var attemptKey = $"{AttemptKeyPrefix}{normalizedUsername}";
        await _cache.RemoveAsync(attemptKey);
    }

    public async Task<int> GetLockoutRemainingSecondsAsync(string username)
    {
        var lockoutKey = $"{LockoutKeyPrefix}{username.ToLowerInvariant()}";
        var lockoutTime = await _cache.GetAsync<DateTime>(lockoutKey);
        
        if (lockoutTime == default)
            return 0;

        var elapsed = DateTime.UtcNow - lockoutTime;
        var remaining = _lockoutDuration - elapsed;
        
        return remaining.TotalSeconds > 0 ? (int)remaining.TotalSeconds : 0;
    }
}