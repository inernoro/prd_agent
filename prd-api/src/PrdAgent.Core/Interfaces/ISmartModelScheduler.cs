namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 模型解析类型（调用大模型的方式）
/// </summary>
public enum ModelResolutionType
{
    /// <summary>直连单模型（传统配置，未使用模型池）</summary>
    DirectModel = 0,
    /// <summary>默认模型池（IsDefaultForType = true）</summary>
    DefaultPool = 1,
    /// <summary>专属模型池（应用绑定的模型池，IsDefaultForType = false）</summary>
    DedicatedPool = 2
}

/// <summary>
/// 调度器返回结果，包含客户端和模型池信息
/// </summary>
public record ScheduledClientResult(
    ILLMClient Client,
    /// <summary>模型解析类型（0=直连单模型, 1=默认模型池, 2=专属模型池）</summary>
    ModelResolutionType ResolutionType,
    string? ModelGroupId,
    string? ModelGroupName);

/// <summary>
/// 模型解析结果（不创建客户端，仅返回模型信息）
/// </summary>
public record ResolvedModelInfo(
    /// <summary>模型解析类型（0=直连单模型, 1=默认模型池, 2=专属模型池）</summary>
    ModelResolutionType ResolutionType,
    /// <summary>模型池ID（如果来自模型池）</summary>
    string? ModelGroupId,
    /// <summary>模型池名称（如果来自模型池）</summary>
    string? ModelGroupName,
    /// <summary>平台ID</summary>
    string PlatformId,
    /// <summary>平台名称</summary>
    string PlatformName,
    /// <summary>模型ID（实际调用名）</summary>
    string ModelId,
    /// <summary>模型显示名称</summary>
    string? ModelDisplayName,
    /// <summary>健康状态</summary>
    string HealthStatus,
    /// <summary>统计数据（可选）</summary>
    ResolvedModelStats? Stats = null);

/// <summary>
/// 模型解析结果中的统计数据
/// </summary>
public record ResolvedModelStats(
    /// <summary>请求次数</summary>
    int RequestCount,
    /// <summary>平均耗时（毫秒）</summary>
    int? AvgDurationMs,
    /// <summary>首字延迟（毫秒）</summary>
    int? AvgTtfbMs,
    /// <summary>总输入Token</summary>
    long? TotalInputTokens,
    /// <summary>总输出Token</summary>
    long? TotalOutputTokens,
    /// <summary>成功次数</summary>
    int? SuccessCount,
    /// <summary>失败次数</summary>
    int? FailCount);

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

    /// <summary>
    /// 获取应用绑定的模型池信息（仅返回池信息，不创建客户端）
    /// </summary>
    /// <param name="appCallerCode">应用标识</param>
    /// <param name="modelType">模型类型</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>模型池信息，如果未找到则返回 null</returns>
    Task<Core.Models.ModelGroup?> GetModelGroupForAppAsync(string appCallerCode, string modelType, CancellationToken ct = default);

    /// <summary>
    /// 解析应用实际会调用的模型（不创建客户端，仅返回模型信息）
    /// 按优先级查找：1.专属模型池 2.默认模型池 3.传统配置模型
    /// </summary>
    /// <param name="appCallerCode">应用标识</param>
    /// <param name="modelType">模型类型</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>解析后的模型信息，如果未找到则返回 null</returns>
    Task<ResolvedModelInfo?> ResolveModelAsync(string appCallerCode, string modelType, CancellationToken ct = default);
}
