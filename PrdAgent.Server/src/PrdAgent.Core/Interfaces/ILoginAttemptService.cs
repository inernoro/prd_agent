namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 登录尝试服务接口
/// </summary>
public interface ILoginAttemptService
{
    /// <summary>检查是否被锁定</summary>
    Task<bool> IsLockedAsync(string username);

    /// <summary>记录失败尝试</summary>
    Task RecordFailedAttemptAsync(string username);

    /// <summary>重置尝试记录</summary>
    Task ResetAttemptsAsync(string username);

    /// <summary>获取剩余锁定时间（秒）</summary>
    Task<int> GetLockoutRemainingSecondsAsync(string username);
}



