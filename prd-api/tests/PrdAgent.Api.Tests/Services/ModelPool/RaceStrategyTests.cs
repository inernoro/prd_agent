using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.Infrastructure.ModelPool.Models;
using PrdAgent.Infrastructure.ModelPool.Strategies;
using Xunit;

namespace PrdAgent.Api.Tests.Services.ModelPool;

/// <summary>
/// Race (演示型) 策略单元测试
/// - 并发请求所有模型，挑最快返回的成功结果
/// </summary>
public class RaceStrategyTests
{
    private readonly RaceStrategy _strategy = new();

    [Fact]
    public async Task Execute_AllSuccess_ShouldReturnFastest()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("slow-model", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("fast-model", "plat-2", priority: 2)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:slow-model", new EndpointBehavior { LatencyMs = 500, ResponseBody = "{\"slow\":true}" })
            .WithEndpoint("plat-2:fast-model", new EndpointBehavior { LatencyMs = 10, ResponseBody = "{\"fast\":true}" });

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        // 最快的端点应该胜出
        Assert.Equal("fast-model", result.DispatchedEndpoint!.ModelId);
        Assert.Equal(PoolStrategyType.Race, result.StrategyUsed);
    }

    [Fact]
    public async Task Execute_FirstFails_ShouldReturnSecond()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("failing-model", "plat-1"),
            TestDataHelper.CreateEndpoint("success-model", "plat-2")
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:failing-model", new EndpointBehavior { ShouldFail = true, ErrorMessage = "Fail", LatencyMs = 10 })
            .WithEndpoint("plat-2:success-model", new EndpointBehavior { LatencyMs = 50, ResponseBody = "{}" });

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        Assert.Equal("success-model", result.DispatchedEndpoint!.ModelId);
    }

    [Fact]
    public async Task Execute_AllFail_ShouldReturnError()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("fail-1", "plat-1"),
            TestDataHelper.CreateEndpoint("fail-2", "plat-2")
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher()
            .WithDefaultFailure("Mock failure");

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.False(result.Success);
        Assert.Equal("ALL_ENDPOINTS_FAILED", result.ErrorCode);
        Assert.Equal(2, result.EndpointsAttempted);
    }

    [Fact]
    public async Task Execute_SingleEndpoint_ShouldWorkLikeFailFast()
    {
        var endpoints = TestDataHelper.CreateEndpoints(("gpt-4o", 1));
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess(50, "{\"ok\":true}");

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        Assert.Equal("gpt-4o", result.DispatchedEndpoint!.ModelId);
        Assert.Equal(1, dispatcher.Records.Count);
    }

    [Fact]
    public async Task Execute_ShouldAttemptAllEndpoints()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-1", "plat-1"),
            TestDataHelper.CreateEndpoint("model-2", "plat-2"),
            TestDataHelper.CreateEndpoint("model-3", "plat-3")
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:model-1", new EndpointBehavior { LatencyMs = 200, ResponseBody = "{}" })
            .WithEndpoint("plat-2:model-2", new EndpointBehavior { LatencyMs = 200, ResponseBody = "{}" })
            .WithEndpoint("plat-3:model-3", new EndpointBehavior { LatencyMs = 200, ResponseBody = "{}" });

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        Assert.Equal(3, result.EndpointsAttempted);
    }

    [Fact]
    public async Task Execute_NoAvailableEndpoints_ShouldReturnError()
    {
        var endpoints = new List<PoolEndpoint>();
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher();

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.False(result.Success);
        Assert.Equal("NO_AVAILABLE_ENDPOINTS", result.ErrorCode);
    }

    [Fact]
    public async Task Execute_ShouldUpdateHealthForAllAttempts()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("fail-model", "plat-1"),
            TestDataHelper.CreateEndpoint("ok-model", "plat-2")
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:fail-model", new EndpointBehavior { ShouldFail = true, LatencyMs = 10 })
            .WithEndpoint("plat-2:ok-model", new EndpointBehavior { LatencyMs = 50, ResponseBody = "{}" });

        await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.Equal(1, healthTracker.GetConsecutiveFailures("plat-1:fail-model"));
        Assert.Equal(EndpointHealthStatus.Healthy, healthTracker.GetStatus("plat-2:ok-model"));
    }
}
