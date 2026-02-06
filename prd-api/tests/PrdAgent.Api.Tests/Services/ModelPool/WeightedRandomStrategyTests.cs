using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.Infrastructure.ModelPool.Models;
using PrdAgent.Infrastructure.ModelPool.Strategies;
using Xunit;

namespace PrdAgent.Api.Tests.Services.ModelPool;

/// <summary>
/// WeightedRandom (加权随机型) 策略单元测试
/// - 按优先级权重随机选择模型
/// </summary>
public class WeightedRandomStrategyTests
{
    [Fact]
    public async Task Execute_ShouldFavorHighPriority()
    {
        var strategy = new WeightedRandomStrategy();
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("high-priority", "plat-1", priority: 1),  // weight = 1/1 = 1.0
            TestDataHelper.CreateEndpoint("low-priority", "plat-2", priority: 10)   // weight = 1/10 = 0.1
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var selections = new Dictionary<string, int> { ["high-priority"] = 0, ["low-priority"] = 0 };

        for (int i = 0; i < 1000; i++)
        {
            var result = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);
            selections[result.DispatchedEndpoint!.ModelId]++;
        }

        // 高优先级端点应该被选中更多次（约 91% vs 9%）
        Assert.True(selections["high-priority"] > selections["low-priority"] * 2,
            $"High={selections["high-priority"]}, Low={selections["low-priority"]}");
    }

    [Fact]
    public async Task Execute_EqualPriority_ShouldDistributeEvenly()
    {
        var strategy = new WeightedRandomStrategy();
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-a", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("model-b", "plat-2", priority: 1)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var selections = new Dictionary<string, int> { ["model-a"] = 0, ["model-b"] = 0 };

        for (int i = 0; i < 1000; i++)
        {
            var result = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);
            selections[result.DispatchedEndpoint!.ModelId]++;
        }

        // 两个端点应该大致均匀（各约50%，允许 15% 偏差）
        Assert.True(selections["model-a"] > 350, $"model-a = {selections["model-a"]}");
        Assert.True(selections["model-b"] > 350, $"model-b = {selections["model-b"]}");
    }

    [Fact]
    public async Task Execute_SingleEndpoint_ShouldAlwaysSelect()
    {
        var strategy = new WeightedRandomStrategy();
        var endpoints = TestDataHelper.CreateEndpoints(("only-model", 5));
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var result = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        Assert.Equal("only-model", result.DispatchedEndpoint!.ModelId);
    }

    [Fact]
    public async Task Execute_DegradedEndpoints_ShouldReduceWeight()
    {
        var strategy = new WeightedRandomStrategy();
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("degraded-model", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("healthy-model", "plat-2", priority: 1)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker { DegradeThreshold = 1 };
        healthTracker.RecordFailure("plat-1:degraded-model"); // Degrade first endpoint
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var selections = new Dictionary<string, int> { ["degraded-model"] = 0, ["healthy-model"] = 0 };

        for (int i = 0; i < 1000; i++)
        {
            var result = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);
            selections[result.DispatchedEndpoint!.ModelId]++;
        }

        // 健康端点应该比降级端点多（约 2:1 比例）
        Assert.True(selections["healthy-model"] > selections["degraded-model"],
            $"Healthy={selections["healthy-model"]}, Degraded={selections["degraded-model"]}");
    }

    [Fact]
    public async Task Execute_ShouldReturnCorrectStrategyType()
    {
        var strategy = new WeightedRandomStrategy();
        var endpoints = TestDataHelper.CreateEndpoints(("gpt-4o", 1));
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var result = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);
        Assert.Equal(PoolStrategyType.WeightedRandom, result.StrategyUsed);
    }
}
