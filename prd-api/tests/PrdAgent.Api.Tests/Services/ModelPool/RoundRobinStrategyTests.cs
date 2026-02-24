using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.Infrastructure.ModelPool.Models;
using PrdAgent.Infrastructure.ModelPool.Strategies;
using Xunit;

namespace PrdAgent.Api.Tests.Services.ModelPool;

/// <summary>
/// RoundRobin (轮询型) 策略单元测试
/// - 在健康模型间轮转，均匀分配负载
/// </summary>
public class RoundRobinStrategyTests
{
    [Fact]
    public async Task Execute_ShouldDistributeEvenly()
    {
        var strategy = new RoundRobinStrategy();
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-a", "plat-1"),
            TestDataHelper.CreateEndpoint("model-b", "plat-2"),
            TestDataHelper.CreateEndpoint("model-c", "plat-3")
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var selections = new Dictionary<string, int>
        {
            ["model-a"] = 0, ["model-b"] = 0, ["model-c"] = 0
        };

        for (int i = 0; i < 30; i++)
        {
            var result = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);
            Assert.True(result.Success);
            selections[result.DispatchedEndpoint!.ModelId]++;
        }

        // 每个端点应该被选中 10 次（完美轮询）
        Assert.Equal(10, selections["model-a"]);
        Assert.Equal(10, selections["model-b"]);
        Assert.Equal(10, selections["model-c"]);
    }

    [Fact]
    public async Task Execute_SingleEndpoint_ShouldAlwaysSelect()
    {
        var strategy = new RoundRobinStrategy();
        var endpoints = TestDataHelper.CreateEndpoints(("only-model", 1));
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        for (int i = 0; i < 5; i++)
        {
            var result = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);
            Assert.True(result.Success);
            Assert.Equal("only-model", result.DispatchedEndpoint!.ModelId);
        }
    }

    [Fact]
    public async Task Execute_SkipsUnavailableEndpoints()
    {
        var strategy = new RoundRobinStrategy();
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-a", "plat-1"),
            TestDataHelper.CreateEndpoint("model-b", "plat-2"),
            TestDataHelper.CreateEndpoint("model-c", "plat-3")
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker { UnavailableThreshold = 1 };
        healthTracker.RecordFailure("plat-2:model-b"); // Mark model-b as unavailable
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var selections = new HashSet<string>();
        for (int i = 0; i < 10; i++)
        {
            var result = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);
            Assert.True(result.Success);
            selections.Add(result.DispatchedEndpoint!.ModelId);
        }

        // model-b should never be selected
        Assert.DoesNotContain("model-b", selections);
        Assert.Contains("model-a", selections);
        Assert.Contains("model-c", selections);
    }

    [Fact]
    public async Task Execute_ShouldReturnCorrectStrategyType()
    {
        var strategy = new RoundRobinStrategy();
        var endpoints = TestDataHelper.CreateEndpoints(("gpt-4o", 1));
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var result = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.Equal(PoolStrategyType.RoundRobin, result.StrategyUsed);
    }
}
