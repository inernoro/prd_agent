using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 应用设置服务（提供缓存）
/// </summary>
public interface IAppSettingsService
{
    /// <summary>
    /// 获取应用设置（带缓存）
    /// </summary>
    Task<AppSettings> GetSettingsAsync(CancellationToken ct = default);

    /// <summary>
    /// 刷新缓存
    /// </summary>
    Task RefreshAsync(CancellationToken ct = default);
}

