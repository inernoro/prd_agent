using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.Infrastructure.ModelPool.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services.ModelPool;

/// <summary>
/// PoolHealthTracker 单元测试
/// </summary>
public class PoolHealthTrackerTests
{
    [Fact]
    public void NewEndpoint_ShouldBeHealthy()
    {
        var tracker = new PoolHealthTracker();
        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus("ep-1"));
        Assert.True(tracker.IsAvailable("ep-1"));
        Assert.Equal(100, tracker.GetHealthScore("ep-1"));
    }

    [Fact]
    public void RecordSuccess_ShouldMaintainHealthy()
    {
        var tracker = new PoolHealthTracker();
        tracker.RecordSuccess("ep-1", 100);

        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus("ep-1"));
        Assert.Equal(0, tracker.GetConsecutiveFailures("ep-1"));
    }

    [Fact]
    public void RecordFailure_BelowDegradeThreshold_ShouldStayHealthy()
    {
        var tracker = new PoolHealthTracker { DegradeThreshold = 3 };
        tracker.RecordFailure("ep-1");
        tracker.RecordFailure("ep-1");

        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus("ep-1"));
        Assert.Equal(2, tracker.GetConsecutiveFailures("ep-1"));
    }

    [Fact]
    public void RecordFailure_AtDegradeThreshold_ShouldDegrade()
    {
        var tracker = new PoolHealthTracker { DegradeThreshold = 3 };
        tracker.RecordFailure("ep-1");
        tracker.RecordFailure("ep-1");
        tracker.RecordFailure("ep-1");

        Assert.Equal(EndpointHealthStatus.Degraded, tracker.GetStatus("ep-1"));
        Assert.Equal(3, tracker.GetConsecutiveFailures("ep-1"));
    }

    [Fact]
    public void RecordFailure_AtUnavailableThreshold_ShouldBecomeUnavailable()
    {
        var tracker = new PoolHealthTracker { DegradeThreshold = 3, UnavailableThreshold = 5 };
        for (int i = 0; i < 5; i++)
            tracker.RecordFailure("ep-1");

        Assert.Equal(EndpointHealthStatus.Unavailable, tracker.GetStatus("ep-1"));
        Assert.False(tracker.IsAvailable("ep-1"));
        Assert.Equal(0, tracker.GetHealthScore("ep-1"));
    }

    [Fact]
    public void RecordSuccess_AfterFailures_ShouldRecoverToHealthy()
    {
        var tracker = new PoolHealthTracker { DegradeThreshold = 3 };
        tracker.RecordFailure("ep-1");
        tracker.RecordFailure("ep-1");
        tracker.RecordFailure("ep-1");
        Assert.Equal(EndpointHealthStatus.Degraded, tracker.GetStatus("ep-1"));

        tracker.RecordSuccess("ep-1", 50);
        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus("ep-1"));
        Assert.Equal(0, tracker.GetConsecutiveFailures("ep-1"));
    }

    [Fact]
    public void RecordSuccess_AfterUnavailable_ShouldRecoverToHealthy()
    {
        var tracker = new PoolHealthTracker { UnavailableThreshold = 5 };
        for (int i = 0; i < 5; i++)
            tracker.RecordFailure("ep-1");
        Assert.Equal(EndpointHealthStatus.Unavailable, tracker.GetStatus("ep-1"));

        tracker.RecordSuccess("ep-1", 50);
        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus("ep-1"));
        Assert.True(tracker.IsAvailable("ep-1"));
    }

    [Fact]
    public void AverageLatency_ShouldTrackSlidingWindow()
    {
        var tracker = new PoolHealthTracker { LatencyWindowSize = 3 };
        tracker.RecordSuccess("ep-1", 100);
        tracker.RecordSuccess("ep-1", 200);
        tracker.RecordSuccess("ep-1", 300);

        Assert.Equal(200, tracker.GetAverageLatencyMs("ep-1"));

        // 超过窗口大小，最早的被丢弃
        tracker.RecordSuccess("ep-1", 400);
        Assert.Equal(300, tracker.GetAverageLatencyMs("ep-1")); // (200+300+400)/3
    }

    [Fact]
    public void ResetHealth_ShouldRestoreToHealthy()
    {
        var tracker = new PoolHealthTracker();
        for (int i = 0; i < 5; i++)
            tracker.RecordFailure("ep-1");

        tracker.ResetHealth("ep-1");
        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus("ep-1"));
        Assert.Equal(0, tracker.GetConsecutiveFailures("ep-1"));
    }

    [Fact]
    public void ResetAll_ShouldResetAllEndpoints()
    {
        var tracker = new PoolHealthTracker();
        for (int i = 0; i < 5; i++)
        {
            tracker.RecordFailure("ep-1");
            tracker.RecordFailure("ep-2");
        }

        tracker.ResetAll();
        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus("ep-1"));
        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus("ep-2"));
    }

    [Fact]
    public void GetSnapshot_ShouldReturnAllEndpointInfo()
    {
        var tracker = new PoolHealthTracker();
        var endpoints = new List<PoolEndpoint>
        {
            TestDataHelper.CreateEndpoint("model-1", "plat-1"),
            TestDataHelper.CreateEndpoint("model-2", "plat-2")
        };

        tracker.RecordSuccess("plat-1:model-1", 100);
        tracker.RecordFailure("plat-2:model-2");

        var snapshot = tracker.GetSnapshot(endpoints);

        Assert.Equal(2, snapshot.TotalCount);
        Assert.Equal(1, snapshot.HealthyCount);
        Assert.False(snapshot.IsFullyUnavailable);

        var ep1 = snapshot.Endpoints.First(e => e.EndpointId == "plat-1:model-1");
        Assert.Equal(EndpointHealthStatus.Healthy, ep1.Status);
        Assert.NotNull(ep1.AverageLatencyMs);
        Assert.Equal(100, ep1.AverageLatencyMs);
    }

    [Fact]
    public void MultipleEndpoints_ShouldTrackIndependently()
    {
        var tracker = new PoolHealthTracker { DegradeThreshold = 2 };
        tracker.RecordFailure("ep-1");
        tracker.RecordFailure("ep-1");
        tracker.RecordSuccess("ep-2", 50);

        Assert.Equal(EndpointHealthStatus.Degraded, tracker.GetStatus("ep-1"));
        Assert.Equal(EndpointHealthStatus.Healthy, tracker.GetStatus("ep-2"));
    }

    [Fact]
    public void HealthScore_ShouldDecreasWithFailures()
    {
        var tracker = new PoolHealthTracker { DegradeThreshold = 3, UnavailableThreshold = 5 };

        // Healthy with 0 failures = 100
        Assert.Equal(100, tracker.GetHealthScore("ep-1"));

        // 1 failure = 95
        tracker.RecordFailure("ep-1");
        Assert.True(tracker.GetHealthScore("ep-1") < 100);

        // 3 failures = Degraded, lower score
        tracker.RecordFailure("ep-1");
        tracker.RecordFailure("ep-1");
        Assert.True(tracker.GetHealthScore("ep-1") <= 50);

        // 5 failures = Unavailable = 0
        tracker.RecordFailure("ep-1");
        tracker.RecordFailure("ep-1");
        Assert.Equal(0, tracker.GetHealthScore("ep-1"));
    }
}
