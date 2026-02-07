using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool;

/// <summary>
/// 模型池 HTTP 请求执行器接口
/// 封装实际的 HTTP 请求发送，策略通过此接口执行请求
/// 可独立 Mock 用于单元测试
/// </summary>
public interface IPoolHttpDispatcher
{
    /// <summary>
    /// 向指定端点发送非流式请求
    /// </summary>
    /// <param name="endpoint">目标端点</param>
    /// <param name="request">请求信息</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>原始 HTTP 响应结果</returns>
    Task<PoolHttpResult> SendAsync(PoolEndpoint endpoint, PoolRequest request, CancellationToken ct = default);

    /// <summary>
    /// 向指定端点发送流式请求
    /// </summary>
    IAsyncEnumerable<PoolStreamChunk> SendStreamAsync(PoolEndpoint endpoint, PoolRequest request, CancellationToken ct = default);
}

/// <summary>
/// 原始 HTTP 响应结果（策略层使用）
/// </summary>
public class PoolHttpResult
{
    /// <summary>是否 HTTP 成功 (2xx)</summary>
    public bool IsSuccess { get; init; }

    /// <summary>HTTP 状态码</summary>
    public int StatusCode { get; init; }

    /// <summary>响应体</summary>
    public string? ResponseBody { get; init; }

    /// <summary>错误消息</summary>
    public string? ErrorMessage { get; init; }

    /// <summary>请求耗时（毫秒）</summary>
    public long LatencyMs { get; init; }

    /// <summary>Token 使用量</summary>
    public PoolTokenUsage? TokenUsage { get; init; }

    public static PoolHttpResult Success(string responseBody, long latencyMs, PoolTokenUsage? tokenUsage = null) => new()
    {
        IsSuccess = true,
        StatusCode = 200,
        ResponseBody = responseBody,
        LatencyMs = latencyMs,
        TokenUsage = tokenUsage
    };

    public static PoolHttpResult Fail(string error, int statusCode = 500, long latencyMs = 0) => new()
    {
        IsSuccess = false,
        StatusCode = statusCode,
        ErrorMessage = error,
        LatencyMs = latencyMs
    };
}
