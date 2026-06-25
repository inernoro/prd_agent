using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.Infrastructure.ModelPool.Models;
using PrdAgent.Infrastructure.ModelPool.Testing;
using Xunit;

namespace PrdAgent.Api.Tests.Services.ModelPool;

/// <summary>
/// 模型池集成测试（包含 URL 测试和端点测试）
/// 标记为 Integration，默认不在 CI 中运行
/// </summary>
[Trait("Category", "Integration")]
public class ModelPoolIntegrationTests
{
    /// <summary>
    /// 测试 HttpPoolDispatcher 能正确构建请求并处理超时
    /// 使用不存在的 URL 来测试超时和错误处理
    /// </summary>
    [Fact]
    public async Task HttpPoolDispatcher_InvalidUrl_ShouldReturnError()
    {
        var httpDispatcher = new HttpPoolDispatcher(new TestHttpClientFactory());
        var endpoint = new PoolEndpoint
        {
            EndpointId = "test:model",
            ModelId = "test-model",
            PlatformId = "test",
            PlatformType = "openai",
            ApiUrl = "https://localhost:9999", // 不存在的端口
            ApiKey = "sk-test",
            Priority = 1
        };

        var request = TestDataHelper.CreateRequest();
        request.RequestBody["max_tokens"] = 10;

        var result = await httpDispatcher.SendAsync(endpoint, new PoolRequest
        {
            ModelType = "chat",
            RequestBody = request.RequestBody,
            TimeoutSeconds = 3
        });

        Assert.False(result.IsSuccess);
        Assert.True(result.LatencyMs > 0);
    }

    /// <summary>
    /// 测试 HttpPoolEndpointTester 的端点测试能力
    /// </summary>
    [Fact]
    public async Task HttpPoolEndpointTester_InvalidEndpoint_ShouldReturnFailure()
    {
        var httpDispatcher = new HttpPoolDispatcher(new TestHttpClientFactory());
        var tester = new HttpPoolEndpointTester(httpDispatcher);

        var endpoint = new PoolEndpoint
        {
            EndpointId = "test:invalid",
            ModelId = "invalid-model",
            PlatformId = "test",
            PlatformType = "openai",
            ApiUrl = "https://localhost:9999",
            ApiKey = "sk-test"
        };

        var result = await tester.TestAsync(endpoint, new PoolTestRequest
        {
            TimeoutSeconds = 3,
            MaxTokens = 10
        });

        Assert.False(result.Success);
        Assert.Equal("test:invalid", result.EndpointId);
        Assert.True(result.LatencyMs > 0);
        Assert.NotNull(result.ErrorMessage);
    }

    /// <summary>
    /// 测试完整的模型池调度+测试流程（使用 Mock 端点）
    /// 调度已化简为只有 FailFast：选最优端点，失败直接返回（不顺延）。
    /// </summary>
    [Fact]
    public async Task FullPoolLifecycle_WithMockEndpoints()
    {
        // 1. 创建池
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-a", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("model-b", "plat-2", priority: 2)
        };

        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:model-a", new EndpointBehavior { LatencyMs = 50, ResponseBody = "{\"ok\":1}" })
            .WithEndpoint("plat-2:model-b", new EndpointBehavior { LatencyMs = 100, ResponseBody = "{\"ok\":2}" });

        var pool = ModelPoolDispatcher.Create("pool-1", "Lifecycle Test Pool",
            endpoints, PoolStrategyType.FailFast, dispatcher);

        // 2. 验证初始配置
        var config = pool.GetConfig();
        Assert.Equal(PoolStrategyType.FailFast, config.Strategy);
        Assert.Equal(2, config.Endpoints.Count);

        // 3. 调度请求 —— 命中优先级最高的端点
        var response = await pool.DispatchAsync(TestDataHelper.CreateRequest());
        Assert.True(response.Success);
        Assert.Equal("model-a", response.DispatchedEndpoint!.ModelId);

        // 4. 验证健康状态
        var snapshot = pool.GetHealthSnapshot();
        Assert.Equal(2, snapshot.HealthyCount);

        // 5. 测试端点
        var testResults = await pool.TestEndpointsAsync(null);
        Assert.Equal(2, testResults.Count);
        Assert.All(testResults, r => Assert.True(r.Success));

        // 6. 首选端点失败 —— FailFast 不顺延，直接返回失败
        var failDispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:model-a", new EndpointBehavior { ShouldFail = true })
            .WithEndpoint("plat-2:model-b", new EndpointBehavior { ResponseBody = "{}" });

        var pool2 = ModelPoolDispatcher.Create("pool-1", "FailFast Pool",
            endpoints, PoolStrategyType.FailFast, failDispatcher);

        var response2 = await pool2.DispatchAsync(TestDataHelper.CreateRequest());
        Assert.False(response2.Success);
        Assert.Equal("model-a", response2.DispatchedEndpoint!.ModelId);
        Assert.Equal(1, response2.EndpointsAttempted);

        // 7. 重置健康
        pool2.ResetAllHealth();
        var snapshot2 = pool2.GetHealthSnapshot();
        Assert.Equal(2, snapshot2.HealthyCount);
    }

    /// <summary>
    /// 池一律按 FailFast 调度（非 FailFast 策略引擎已删除，枚举仅作数据兼容保留）。
    /// </summary>
    [Theory]
    [InlineData(PoolStrategyType.FailFast)]
    [InlineData(PoolStrategyType.Sequential)]
    [InlineData(PoolStrategyType.RoundRobin)]
    public async Task AnyStrategyType_WithMockEndpoints_DispatchesAsFailFast(PoolStrategyType strategyType)
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-a", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("model-b", "plat-2", priority: 2)
        };

        var dispatcher = new MockPoolHttpDispatcher()
            .WithDefaultSuccess(50, "{\"ok\":true}");

        var pool = ModelPoolDispatcher.Create("pool-1", "Strategy Test Pool",
            endpoints, strategyType, dispatcher);

        var result = await pool.DispatchAsync(TestDataHelper.CreateRequest());

        Assert.True(result.Success);
        Assert.Equal(PoolStrategyType.FailFast, result.StrategyUsed);
        Assert.NotNull(result.DispatchedEndpoint);
    }

    /// <summary>
    /// 测试池的并发安全性（FailFast 下并发请求始终命中优先级最高的端点）。
    /// </summary>
    [Fact]
    public async Task ConcurrentDispatches_ShouldBeSafe()
    {
        var endpoints = TestDataHelper.CreateEndpoints(
            ("model-a", 1), ("model-b", 2), ("model-c", 3));
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess(10);

        var pool = ModelPoolDispatcher.Create("pool-1", "Concurrent Test Pool",
            endpoints, PoolStrategyType.FailFast, dispatcher);

        var tasks = Enumerable.Range(0, 100)
            .Select(_ => pool.DispatchAsync(TestDataHelper.CreateRequest()));

        var results = await Task.WhenAll(tasks);

        Assert.All(results, r => Assert.True(r.Success));
        Assert.Equal(100, results.Length);

        // FailFast：所有请求都命中优先级最高的 model-a
        Assert.All(results, r => Assert.Equal("model-a", r.DispatchedEndpoint!.ModelId));
    }

    /// <summary>
    /// 测试 StrategyType int 转换正确（枚举成员保留，数据兼容）。
    /// </summary>
    [Theory]
    [InlineData(0, PoolStrategyType.FailFast)]
    [InlineData(1, PoolStrategyType.Race)]
    [InlineData(2, PoolStrategyType.Sequential)]
    [InlineData(3, PoolStrategyType.RoundRobin)]
    [InlineData(4, PoolStrategyType.WeightedRandom)]
    [InlineData(5, PoolStrategyType.LeastLatency)]
    public void PoolStrategyType_IntConversion_ShouldBeCorrect(int intValue, PoolStrategyType expected)
    {
        var actual = (PoolStrategyType)intValue;
        Assert.Equal(expected, actual);
    }
}

internal class TestHttpClientFactory : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => new();
}
