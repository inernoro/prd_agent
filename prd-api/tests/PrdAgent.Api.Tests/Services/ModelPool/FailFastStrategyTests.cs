using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.Infrastructure.ModelPool.Models;
using PrdAgent.Infrastructure.ModelPool.Strategies;
using Xunit;

namespace PrdAgent.Api.Tests.Services.ModelPool;

/// <summary>
/// FailFast 策略单元测试
/// - 选最优模型，失败直接返回错误
/// </summary>
public class FailFastStrategyTests
{
    private readonly FailFastStrategy _strategy = new();

    [Fact]
    public async Task Execute_Success_ShouldReturnOk()
    {
        var endpoints = TestDataHelper.CreateEndpoints(("gpt-4o", 1));
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher()
            .WithDefaultSuccess(100, "{\"choices\":[{\"message\":{\"content\":\"Hello\"}}]}");

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        Assert.Equal(PoolStrategyType.FailFast, result.StrategyUsed);
        Assert.NotNull(result.DispatchedEndpoint);
        Assert.Equal("gpt-4o", result.DispatchedEndpoint!.ModelId);
        Assert.Equal(1, dispatcher.Records.Count);
    }

    [Fact]
    public async Task Execute_Failure_ShouldReturnError()
    {
        var endpoints = TestDataHelper.CreateEndpoints(("gpt-4o", 1));
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher()
            .WithDefaultFailure("Rate limit exceeded", 429);

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.False(result.Success);
        Assert.Equal(1, dispatcher.Records.Count);
    }

    [Fact]
    public async Task Execute_Failure_ShouldUpdateHealthTracker()
    {
        var endpoints = TestDataHelper.CreateEndpoints(("gpt-4o", 1));
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker { DegradeThreshold = 1 };
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultFailure();

        await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.Equal(1, healthTracker.GetConsecutiveFailures(endpoints[0].EndpointId));
    }

    [Fact]
    public async Task Execute_Success_ShouldRecordSuccessInTracker()
    {
        var endpoints = TestDataHelper.CreateEndpoints(("gpt-4o", 1));
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess(50);

        await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.Equal(EndpointHealthStatus.Healthy, healthTracker.GetStatus(endpoints[0].EndpointId));
    }

    [Fact]
    public async Task Execute_MultipleEndpoints_ShouldPickBestByPriority()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-low", "plat-1", priority: 10),
            TestDataHelper.CreateEndpoint("model-high", "plat-2", priority: 1)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        Assert.Equal("model-high", result.DispatchedEndpoint!.ModelId);
    }

    [Fact]
    public async Task Execute_SkipsUnavailableEndpoints()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("unavailable-model", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("healthy-model", "plat-2", priority: 2)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker { UnavailableThreshold = 1 };
        healthTracker.RecordFailure("plat-1:unavailable-model"); // Mark first as unavailable
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        Assert.Equal("healthy-model", result.DispatchedEndpoint!.ModelId);
    }

    [Fact]
    public async Task Execute_NoAvailableEndpoints_ShouldReturnError()
    {
        var endpoints = TestDataHelper.CreateEndpoints(("gpt-4o", 1));
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker { UnavailableThreshold = 1 };
        healthTracker.RecordFailure("plat-1:gpt-4o");
        var dispatcher = new MockPoolHttpDispatcher();

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.False(result.Success);
        Assert.Equal("NO_AVAILABLE_ENDPOINTS", result.ErrorCode);
        Assert.Equal(503, result.StatusCode);
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
    public async Task Execute_PrefersHealthyOverDegraded()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("degraded-model", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("healthy-model", "plat-2", priority: 2)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker { DegradeThreshold = 1 };
        healthTracker.RecordFailure("plat-1:degraded-model"); // Degrade first
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var result = await _strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        Assert.Equal("healthy-model", result.DispatchedEndpoint!.ModelId);
    }

    [Fact]
    public async Task ExecuteStream_Success_ShouldYieldChunks()
    {
        var endpoints = TestDataHelper.CreateEndpoints(("gpt-4o", 1));
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var chunks = new List<PoolStreamChunk>();
        await foreach (var chunk in _strategy.ExecuteStreamAsync(endpoints, request, healthTracker, dispatcher))
        {
            chunks.Add(chunk);
        }

        Assert.True(chunks.Count >= 2); // At least Start + some content
        Assert.Equal(PoolChunkType.Start, chunks[0].Type);
        Assert.Contains(chunks, c => c.Type == PoolChunkType.Text || c.Type == PoolChunkType.Done);
    }
}
