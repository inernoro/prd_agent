using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.Infrastructure.ModelPool.Models;
using PrdAgent.Infrastructure.ModelPool.Strategies;
using Xunit;

namespace PrdAgent.Api.Tests.Services.ModelPool;

/// <summary>
/// LeastLatency (最低延迟型) 策略单元测试
/// - 跟踪平均延迟，总是选最快的模型
/// </summary>
public class LeastLatencyStrategyTests
{
    [Fact]
    public async Task Execute_NewEndpoints_ShouldExploreFirst()
    {
        var strategy = new LeastLatencyStrategy();
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-a", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("model-b", "plat-2", priority: 2)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess(100);

        // 第一次应该选择优先级最高的未知端点
        var result = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);
        Assert.True(result.Success);
        // 新端点时按 priority 排序
        Assert.Equal("model-a", result.DispatchedEndpoint!.ModelId);
    }

    [Fact]
    public async Task Execute_WithLatencyData_ShouldPickFastest()
    {
        var strategy = new LeastLatencyStrategy();
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("slow-model", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("fast-model", "plat-2", priority: 2)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();

        // 预设延迟数据
        healthTracker.RecordSuccess("plat-1:slow-model", 500);
        healthTracker.RecordSuccess("plat-2:fast-model", 50);

        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var result = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        Assert.True(result.Success);
        Assert.Equal("fast-model", result.DispatchedEndpoint!.ModelId);
    }

    [Fact]
    public async Task Execute_ShouldAdapt_WhenLatencyChanges()
    {
        var strategy = new LeastLatencyStrategy();
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-a", "plat-1", priority: 1),
            TestDataHelper.CreateEndpoint("model-b", "plat-2", priority: 2)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker { LatencyWindowSize = 3 };

        // model-a 初始快
        healthTracker.RecordSuccess("plat-1:model-a", 50);
        healthTracker.RecordSuccess("plat-2:model-b", 200);

        var dispatcher1 = new MockPoolHttpDispatcher().WithDefaultSuccess();
        var result1 = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher1);
        Assert.Equal("model-a", result1.DispatchedEndpoint!.ModelId);

        // model-a 变慢
        healthTracker.RecordSuccess("plat-1:model-a", 500);
        healthTracker.RecordSuccess("plat-1:model-a", 500);
        healthTracker.RecordSuccess("plat-1:model-a", 500);

        var dispatcher2 = new MockPoolHttpDispatcher().WithDefaultSuccess();
        var result2 = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher2);
        Assert.Equal("model-b", result2.DispatchedEndpoint!.ModelId);
    }

    [Fact]
    public async Task Execute_MixedUnexploredAndExplored_ShouldPreferUnexplored()
    {
        var strategy = new LeastLatencyStrategy();
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("explored-model", "plat-1", priority: 2),
            TestDataHelper.CreateEndpoint("new-model", "plat-2", priority: 1)
        };
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();

        // Only model-a has been explored
        healthTracker.RecordSuccess("plat-1:explored-model", 100);

        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();
        var result = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);

        // Should prefer the unexplored model
        Assert.Equal("new-model", result.DispatchedEndpoint!.ModelId);
    }

    [Fact]
    public async Task Execute_ShouldReturnCorrectStrategyType()
    {
        var strategy = new LeastLatencyStrategy();
        var endpoints = TestDataHelper.CreateEndpoints(("gpt-4o", 1));
        var request = TestDataHelper.CreateRequest();
        var healthTracker = new PoolHealthTracker();
        var dispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();

        var result = await strategy.ExecuteAsync(endpoints, request, healthTracker, dispatcher);
        Assert.Equal(PoolStrategyType.LeastLatency, result.StrategyUsed);
    }
}
