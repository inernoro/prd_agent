using System.Text.Json.Nodes;
using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool.Testing;

/// <summary>
/// HTTP 端点测试器实现
/// 通过发送轻量请求来测试端点的连通性和响应能力
/// </summary>
public class HttpPoolEndpointTester : IPoolEndpointTester
{
    private readonly IPoolHttpDispatcher _httpDispatcher;

    public HttpPoolEndpointTester(IPoolHttpDispatcher httpDispatcher)
    {
        _httpDispatcher = httpDispatcher;
    }

    /// <inheritdoc />
    public async Task<PoolTestResult> TestAsync(
        PoolEndpoint endpoint,
        PoolTestRequest request,
        CancellationToken ct = default)
    {
        var startedAt = DateTime.UtcNow;

        try
        {
            var poolRequest = new PoolRequest
            {
                ModelType = request.ModelType,
                RequestBody = new JsonObject
                {
                    ["messages"] = new JsonArray
                    {
                        new JsonObject
                        {
                            ["role"] = "user",
                            ["content"] = request.Prompt
                        }
                    },
                    ["max_tokens"] = request.MaxTokens,
                    ["temperature"] = 0.1
                },
                TimeoutSeconds = request.TimeoutSeconds,
                RequestId = $"test-{Guid.NewGuid():N}"
            };

            var result = await _httpDispatcher.SendAsync(endpoint, poolRequest, ct);
            var latencyMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;

            var preview = result.ResponseBody?.Length > 500
                ? result.ResponseBody[..500] + "..."
                : result.ResponseBody;

            return new PoolTestResult
            {
                Success = result.IsSuccess,
                EndpointId = endpoint.EndpointId,
                ModelId = endpoint.ModelId,
                PlatformName = endpoint.PlatformName,
                StatusCode = result.StatusCode,
                LatencyMs = latencyMs,
                ResponsePreview = preview,
                ErrorMessage = result.ErrorMessage,
                TokenUsage = result.TokenUsage,
                TestedAt = DateTime.UtcNow
            };
        }
        catch (Exception ex)
        {
            var latencyMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
            return new PoolTestResult
            {
                Success = false,
                EndpointId = endpoint.EndpointId,
                ModelId = endpoint.ModelId,
                PlatformName = endpoint.PlatformName,
                LatencyMs = latencyMs,
                ErrorMessage = ex.Message,
                TestedAt = DateTime.UtcNow
            };
        }
    }
}
