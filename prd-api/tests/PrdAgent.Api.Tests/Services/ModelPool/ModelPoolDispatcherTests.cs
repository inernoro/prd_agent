using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.Infrastructure.ModelPool.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services.ModelPool;

/// <summary>
/// ModelPoolDispatcher 集成测试
/// 测试完整的调度流程：配置 → 策略选择 → 调度 → 健康追踪
/// </summary>
public class ModelPoolDispatcherTests
{
    #region 基础功能

    [Fact]
    public async Task Dispatch_WithFailFast_ShouldWork()
    {
        var endpoints = TestDataHelper.CreateEndpoints(("gpt-4o", 1));
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess(50, "{\"ok\":true}");
        var pool = ModelPoolDispatcher.Create("pool-1", "Test Pool", endpoints,
            PoolStrategyType.FailFast, dispatcher);

        var result = await pool.DispatchAsync(TestDataHelper.CreateRequest());

        Assert.True(result.Success);
        Assert.Equal(PoolStrategyType.FailFast, result.StrategyUsed);
    }

    [Fact]
    public async Task Dispatch_WithRace_ShouldWork()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-1", "plat-1"),
            TestDataHelper.CreateEndpoint("model-2", "plat-2")
        };
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:model-1", new EndpointBehavior { LatencyMs = 200 })
            .WithEndpoint("plat-2:model-2", new EndpointBehavior { LatencyMs = 10 });

        var pool = ModelPoolDispatcher.Create("pool-1", "Test Pool", endpoints,
            PoolStrategyType.Race, dispatcher);

        var result = await pool.DispatchAsync(TestDataHelper.CreateRequest());

        Assert.True(result.Success);
        Assert.Equal(PoolStrategyType.Race, result.StrategyUsed);
        Assert.Equal("model-2", result.DispatchedEndpoint!.ModelId); // Faster one
    }

    [Fact]
    public async Task Dispatch_WithSequential_ShouldFallback()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("fail-model", "plat-1"),
            TestDataHelper.CreateEndpoint("ok-model", "plat-2")
        };
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:fail-model", new EndpointBehavior { ShouldFail = true })
            .WithEndpoint("plat-2:ok-model", new EndpointBehavior { ResponseBody = "{}" });

        var pool = ModelPoolDispatcher.Create("pool-1", "Test Pool", endpoints,
            PoolStrategyType.Sequential, dispatcher);

        var result = await pool.DispatchAsync(TestDataHelper.CreateRequest());

        Assert.True(result.Success);
        Assert.Equal("ok-model", result.DispatchedEndpoint!.ModelId);
        Assert.Equal(2, result.EndpointsAttempted);
    }

    #endregion

    #region 空池处理

    [Fact]
    public async Task Dispatch_EmptyPool_ShouldReturnError()
    {
        var pool = ModelPoolDispatcher.Create("pool-1", "Empty Pool",
            new List<PoolEndpoint>(), PoolStrategyType.FailFast,
            new MockPoolHttpDispatcher());

        var result = await pool.DispatchAsync(TestDataHelper.CreateRequest());

        Assert.False(result.Success);
        Assert.Equal("EMPTY_POOL", result.ErrorCode);
    }

    #endregion

    #region 健康快照

    [Fact]
    public async Task GetHealthSnapshot_ShouldReflectCurrentState()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-1", "plat-1"),
            TestDataHelper.CreateEndpoint("model-2", "plat-2")
        };
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:model-1", new EndpointBehavior { ResponseBody = "{}" })
            .WithEndpoint("plat-2:model-2", new EndpointBehavior { ShouldFail = true });

        var pool = ModelPoolDispatcher.Create("pool-1", "Test Pool", endpoints,
            PoolStrategyType.FailFast, dispatcher);

        // Trigger some calls
        await pool.DispatchAsync(TestDataHelper.CreateRequest());

        var snapshot = pool.GetHealthSnapshot();
        Assert.Equal(2, snapshot.TotalCount);
    }

    [Fact]
    public void ResetEndpointHealth_ShouldWork()
    {
        var endpoints = TestDataHelper.CreateEndpoints(("model-1", 1));
        var healthTracker = new PoolHealthTracker { UnavailableThreshold = 1 };
        healthTracker.RecordFailure("plat-1:model-1");

        var pool = new ModelPoolDispatcher("pool-1", "Test Pool", endpoints,
            ModelPoolDispatcher.CreateStrategy(PoolStrategyType.FailFast),
            healthTracker, new MockPoolHttpDispatcher());

        pool.ResetEndpointHealth("plat-1:model-1");

        var snapshot = pool.GetHealthSnapshot();
        Assert.Equal(1, snapshot.HealthyCount);
    }

    [Fact]
    public void ResetAllHealth_ShouldResetAll()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("m1", "p1"),
            TestDataHelper.CreateEndpoint("m2", "p2")
        };
        var healthTracker = new PoolHealthTracker { UnavailableThreshold = 1 };
        healthTracker.RecordFailure("p1:m1");
        healthTracker.RecordFailure("p2:m2");

        var pool = new ModelPoolDispatcher("pool-1", "Test Pool", endpoints,
            ModelPoolDispatcher.CreateStrategy(PoolStrategyType.FailFast),
            healthTracker, new MockPoolHttpDispatcher());

        pool.ResetAllHealth();

        var snapshot = pool.GetHealthSnapshot();
        Assert.Equal(2, snapshot.HealthyCount);
        Assert.Equal(0, snapshot.UnavailableCount);
    }

    #endregion

    #region GetConfig

    [Fact]
    public void GetConfig_ShouldReturnPoolInfo()
    {
        var endpoints = TestDataHelper.CreateEndpoints(("gpt-4o", 1), ("claude-3", 2));
        var pool = ModelPoolDispatcher.Create("pool-1", "My Pool", endpoints,
            PoolStrategyType.Sequential, new MockPoolHttpDispatcher());

        var config = pool.GetConfig();

        Assert.Equal("pool-1", config.PoolId);
        Assert.Equal("My Pool", config.PoolName);
        Assert.Equal(PoolStrategyType.Sequential, config.Strategy);
        Assert.Equal(2, config.Endpoints.Count);
    }

    #endregion

    #region 端点测试

    [Fact]
    public async Task TestEndpoints_ShouldTestAll()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-1", "plat-1"),
            TestDataHelper.CreateEndpoint("model-2", "plat-2")
        };
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:model-1", new EndpointBehavior { LatencyMs = 50, ResponseBody = "{}" })
            .WithEndpoint("plat-2:model-2", new EndpointBehavior { ShouldFail = true, ErrorMessage = "API key invalid" });

        var pool = ModelPoolDispatcher.Create("pool-1", "Test Pool", endpoints,
            PoolStrategyType.FailFast, dispatcher);

        var results = await pool.TestEndpointsAsync(null);

        Assert.Equal(2, results.Count);
        Assert.True(results[0].Success);
        Assert.False(results[1].Success);
        Assert.Contains("API key invalid", results[1].ErrorMessage);
    }

    [Fact]
    public async Task TestEndpoints_SpecificEndpoint_ShouldTestOnlyThat()
    {
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-1", "plat-1"),
            TestDataHelper.CreateEndpoint("model-2", "plat-2")
        };
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();
        var pool = ModelPoolDispatcher.Create("pool-1", "Test Pool", endpoints,
            PoolStrategyType.FailFast, dispatcher);

        var results = await pool.TestEndpointsAsync("plat-1:model-1");

        Assert.Single(results);
        Assert.Equal("plat-1:model-1", results[0].EndpointId);
    }

    #endregion

    #region 策略工厂

    [Theory]
    [InlineData(PoolStrategyType.FailFast)]
    [InlineData(PoolStrategyType.Race)]
    [InlineData(PoolStrategyType.Sequential)]
    [InlineData(PoolStrategyType.RoundRobin)]
    [InlineData(PoolStrategyType.WeightedRandom)]
    [InlineData(PoolStrategyType.LeastLatency)]
    public void CreateStrategy_ShouldReturnCorrectType(PoolStrategyType type)
    {
        var strategy = ModelPoolDispatcher.CreateStrategy(type);
        Assert.Equal(type, strategy.StrategyType);
    }

    #endregion

    #region 流式调度

    [Fact]
    public async Task DispatchStream_ShouldYieldChunks()
    {
        var endpoints = TestDataHelper.CreateEndpoints(("gpt-4o", 1));
        var dispatcher = new MockPoolHttpDispatcher()
            .WithEndpoint("plat-1:gpt-4o", new EndpointBehavior
            {
                StreamWords = new[] { "Hello", " ", "World" }
            });
        var pool = ModelPoolDispatcher.Create("pool-1", "Test Pool", endpoints,
            PoolStrategyType.FailFast, dispatcher);

        var chunks = new List<PoolStreamChunk>();
        await foreach (var chunk in pool.DispatchStreamAsync(TestDataHelper.CreateRequest()))
        {
            chunks.Add(chunk);
        }

        Assert.True(chunks.Count >= 2);
        Assert.Equal(PoolChunkType.Start, chunks[0].Type);
    }

    [Fact]
    public async Task DispatchStream_EmptyPool_ShouldYieldError()
    {
        var pool = ModelPoolDispatcher.Create("pool-1", "Empty Pool",
            new List<PoolEndpoint>(), PoolStrategyType.FailFast,
            new MockPoolHttpDispatcher());

        var chunks = new List<PoolStreamChunk>();
        await foreach (var chunk in pool.DispatchStreamAsync(TestDataHelper.CreateRequest()))
        {
            chunks.Add(chunk);
        }

        Assert.Single(chunks);
        Assert.Equal(PoolChunkType.Error, chunks[0].Type);
    }

    #endregion
}
