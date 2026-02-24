using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.Infrastructure.ModelPool.Models;
using PrdAgent.Infrastructure.ModelPool.Strategies;
using Xunit;

namespace PrdAgent.Api.Tests.Services.ModelPool;

/// <summary>
/// Sequential (顺序型) 策略单元测试
/// - 按优先级依次请求，失败则顺延到下一个模型
/// </summary>
public class SequentialStrategyTests
{
    private readonly SequentialStrategy _strategy = new();

    [Fact]
    public async Task Execute_FirstSuccess_ShouldReturnFirst()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-1", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("model-2", "plat-2", priority: 2)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        Assert.Equal("model-1", result.DispatchedEndpoint!.ModelId);
        Assert.Equal(1, result.EndpointsAttempted);
        Assert.Equal(1, dispatcher.Records.Count);
    }

    [Fact]
    public async Task Execute_FirstFails_ShouldFallbackToSecond()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("failing-model", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("ok-model", "plat-2", priority: 2)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:failing-model", new EndpointBehavior { ShouldFail = true, ErrorMessage = "Timeout" })
            .WithEndpoint("plat-2:ok-model", new EndpointBehavior { ResponseBody = "{\"ok\":true}" });

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        Assert.Equal("ok-model", result.DispatchedEndpoint!.ModelId);
        Assert.Equal(2, result.EndpointsAttempted);
        Assert.Equal(PoolStrategyType.Sequential, result.StrategyUsed);
    }

    [Fact]
    public async Task Execute_AllFail_ShouldReturnError()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("fail-1", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("fail-2", "plat-2", priority: 2),
            TestDataHelper.CreateEndpoint("fail-3", "plat-3", priority: 3)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultFailure("Service error", 500);

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.False(result.Success);
        Assert.Equal("ALL_ENDPOINTS_FAILED", result.ErrorCode);
        Assert.Equal(3, result.EndpointsAttempted);
        Assert.Contains("Sequential", result.ErrorMessage);
    }

    [Fact]
    public async Task Execute_FirstTwoFail_ThirdSuccess()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("fail-1", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("fail-2", "plat-2", priority: 2),
            TestDataHelper.CreateEndpoint("ok-3", "plat-3", priority: 3)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:fail-1", new EndpointBehavior { ShouldFail = true })
            .WithEndpoint("plat-2:fail-2", new EndpointBehavior { ShouldFail = true })
            .WithEndpoint("plat-3:ok-3", new EndpointBehavior { ResponseBody = "{}" });

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        Assert.Equal("ok-3", result.DispatchedEndpoint!.ModelId);
        Assert.Equal(3, result.EndpointsAttempted);
    }

    [Fact]
    public async Task Execute_ShouldUpdateHealthForFailedEndpoints()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("fail-model", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("ok-model", "plat-2", priority: 2)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:fail-model", new EndpointBehavior { ShouldFail = true })
            .WithEndpoint("plat-2:ok-model", new EndpointBehavior { ResponseBody = "{}" });

        await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.Equal(1, healthTracker.GetConsecutiveFailures("plat-1:fail-model"));
        Assert.Equal(EndpointHealthStatus.Healthy, healthTracker.GetStatus("plat-2:ok-model"));
    }

    [Fact]
    public async Task Execute_ExceptionInEndpoint_ShouldContinueToNext()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("exception-model", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("ok-model", "plat-2", priority: 2)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:exception-model", new EndpointBehavior
            {
                ThrowException = new HttpRequestException("Connection refused")
            })
            .WithEndpoint("plat-2:ok-model", new EndpointBehavior { ResponseBody = "{}" });

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        Assert.Equal("ok-model", result.DispatchedEndpoint!.ModelId);
    }

    [Fact]
    public async Task Execute_EmptyEndpoints_ShouldReturnError()
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
    public async Task ExecuteStream_FirstFails_ShouldFallbackToSecond()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("fail-model", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("ok-model", "plat-2", priority: 2)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:fail-model", new EndpointBehavior { ShouldFail = true })
            .WithEndpoint("plat-2:ok-model", new EndpointBehavior { StreamWords = new[] { "Hello", " World" } });

        var chunks = new List<PoolStreamChunk>();
        await foreach (var chunk in _strategy.ExecuteStreamAsync(endpoints, request, healthTracker, dispatcher))
        {
            chunks.Add(chunk);
        }

        // Should have Start + Text chunks + Done
        Assert.True(chunks.Count >= 3);
        Assert.Equal(PoolChunkType.Start, chunks[0].Type);
        Assert.Equal("ok-model", chunks[0].DispatchedEndpoint!.ModelId);
    }
}
