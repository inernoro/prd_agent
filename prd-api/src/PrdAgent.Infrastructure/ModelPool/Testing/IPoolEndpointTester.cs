using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool.Testing;

/// <summary>
/// 端点测试器接口
/// 用于测试模型端点的连通性和响应能力
/// </summary>
public interface IPoolEndpointTester
{
    /// <summary>
    /// 测试单个端点
    /// </summary>
    /// <param name="endpoint">要测试的端点</param>
    /// <param name="request">测试请求参数</param>
    /// <param name="ct">取消令牌</param>
    Task<PoolTestResult> TestAsync(PoolEndpoint endpoint, PoolTestRequest request, CancellationToken ct = default);
}
