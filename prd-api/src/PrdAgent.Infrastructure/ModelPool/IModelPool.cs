using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool;

/// <summary>
/// 模型池核心接口 - 独立组件的固定契约
///
/// 设计原则：
/// 1. 不参与业务逻辑（不知道 AppCallerCode、不知道会话/对话）
/// 2. 接受审计字段（userId、requestId）方便追踪
/// 3. 完全自包含：端点管理 + 策略调度 + 健康追踪
/// 4. 可独立测试：支持端点连通性测试
///
/// 未来扩展点：
/// - 计费接口（按 token/请求次数计费）
/// - 限流接口（按 userId 限流）
/// - 独立部署为微服务
/// </summary>
public interface IModelPool
{
    /// <summary>
    /// 发送非流式请求，由策略决定如何选择端点和处理失败
    /// </summary>
    Task<PoolResponse> DispatchAsync(PoolRequest request, CancellationToken ct = default);

    /// <summary>
    /// 发送流式请求
    /// </summary>
    IAsyncEnumerable<PoolStreamChunk> DispatchStreamAsync(PoolRequest request, CancellationToken ct = default);

    /// <summary>
    /// 测试指定端点的连通性（通过发送轻量请求）
    /// </summary>
    /// <param name="endpointId">端点 ID，为 null 时测试所有端点</param>
    /// <param name="testRequest">测试请求</param>
    /// <param name="ct">取消令牌</param>
    Task<List<PoolTestResult>> TestEndpointsAsync(string? endpointId, PoolTestRequest? testRequest = null, CancellationToken ct = default);

    /// <summary>
    /// 获取当前池的健康快照
    /// </summary>
    PoolHealthSnapshot GetHealthSnapshot();

    /// <summary>
    /// 重置指定端点的健康状态
    /// </summary>
    void ResetEndpointHealth(string endpointId);

    /// <summary>
    /// 重置所有端点的健康状态
    /// </summary>
    void ResetAllHealth();

    /// <summary>
    /// 获取池配置信息
    /// </summary>
    ModelPoolConfig GetConfig();
}

/// <summary>
/// 模型池配置
/// </summary>
public class ModelPoolConfig
{
    /// <summary>池 ID</summary>
    public string PoolId { get; init; } = string.Empty;

    /// <summary>池名称</summary>
    public string PoolName { get; init; } = string.Empty;

    /// <summary>策略类型</summary>
    public PoolStrategyType Strategy { get; init; }

    /// <summary>端点列表</summary>
    public IReadOnlyList<PoolEndpoint> Endpoints { get; init; } = Array.Empty<PoolEndpoint>();
}
