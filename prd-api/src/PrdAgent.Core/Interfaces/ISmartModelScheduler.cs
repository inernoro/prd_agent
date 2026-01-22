namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 调度器返回结果，包含客户端和模型池信息
/// </summary>
public record ScheduledClientResult(
    ILLMClient Client,
    string ModelGroupId,
    string ModelGroupName,
    bool IsDefaultModelGroup);

/// <summary>
/// 智能模型调度器 - 负责根据应用需求选择最佳模型并处理降权恢复
/// </summary>
public interface ISmartModelScheduler
{
    /// <summary>
    /// 根据应用标识和模型类型获取客户端
    /// </summary>
    /// <param name="appCallerCode">应用标识（如：chat.sendMessage）</param>
    /// <param name="modelType">模型类型（如：chat, intent, vision）</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>LLM客户端</returns>
    Task<ILLMClient> GetClientAsync(string appCallerCode, string modelType, CancellationToken ct = default);

    /// <summary>
    /// 根据应用标识和模型类型获取客户端（包含模型池信息）
    /// </summary>
    /// <param name="appCallerCode">应用标识（如：chat.sendMessage）</param>
    /// <param name="modelType">模型类型（如：chat, intent, vision）</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>调度结果，包含客户端和模型池信息</returns>
    Task<ScheduledClientResult> GetClientWithGroupInfoAsync(string appCallerCode, string modelType, CancellationToken ct = default);
    
    /// <summary>
    /// 记录调用结果，触发降权/恢复逻辑
    /// </summary>
    /// <param name="groupId">分组ID</param>
    /// <param name="modelId">模型ID</param>
    /// <param name="platformId">平台ID</param>
    /// <param name="success">是否成功</param>
    /// <param name="error">错误信息（可选）</param>
    /// <param name="ct">取消令牌</param>
    Task RecordCallResultAsync(string groupId, string modelId, string platformId, bool success, string? error = null, CancellationToken ct = default);
    
    /// <summary>
    /// 健康检查（后台定时任务调用）
    /// </summary>
    /// <param name="ct">取消令牌</param>
    Task HealthCheckAsync(CancellationToken ct = default);
    
    /// <summary>
    /// 获取或创建应用调用者（自动注册）
    /// </summary>
    /// <param name="appCallerCode">应用标识</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>应用调用者</returns>
    Task<Core.Models.LLMAppCaller> GetOrCreateAppCallerAsync(string appCallerCode, CancellationToken ct = default);
}
