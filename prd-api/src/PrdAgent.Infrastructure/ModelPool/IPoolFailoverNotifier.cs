using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.ModelPool;

/// <summary>
/// 模型池故障/恢复通知接口
/// </summary>
public interface IPoolFailoverNotifier
{
    /// <summary>
    /// 通知模型池全部不可用
    /// </summary>
    Task NotifyPoolExhaustedAsync(ModelGroup pool, CancellationToken ct = default);

    /// <summary>
    /// 通知模型池已恢复（至少一个端点恢复健康）
    /// </summary>
    Task NotifyPoolRecoveredAsync(ModelGroup pool, string recoveredModelId, TimeSpan downDuration, CancellationToken ct = default);

    /// <summary>
    /// 向请求失败的用户发送故障通知（以最新一条为准，避免重复）
    /// </summary>
    Task NotifyUserFailureAsync(string userId, string modelType, string poolName, CancellationToken ct = default);

    /// <summary>
    /// 关闭指定用户的故障通知（模型恢复后）
    /// </summary>
    Task CloseUserFailureNotificationsAsync(string modelType, CancellationToken ct = default);
}
