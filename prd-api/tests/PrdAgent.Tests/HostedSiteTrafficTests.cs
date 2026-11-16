using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class HostedSiteTrafficTests
{
    private static readonly DateTime Start = new(2026, 11, 4, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void OwnAccessHasAllMetricsButNoExternalMetrics()
    {
        var accumulator = new HostedSiteTrafficAccumulator("owner");
        accumulator.Add("owner", "1.2.3.4", Start);
        var traffic = accumulator.Value;
        Assert.Equal(1, traffic.All.Visits);
        Assert.Equal(1, traffic.All.Visitors);
        Assert.Equal(Start, traffic.All.LastViewedAt);
        Assert.Equal(0, traffic.External.Visits);
        Assert.Equal(0, traffic.External.Visitors);
        Assert.Null(traffic.External.LastViewedAt);
    }

    [Fact]
    public void BothSourcesInSameWindowCountOnceButKeepLatestTime()
    {
        var accumulator = new HostedSiteTrafficAccumulator("owner");
        accumulator.Add("visitor", "5.6.7.8", Start.AddMinutes(15));
        accumulator.Add("visitor", "1.2.3.4", Start.AddMinutes(2));
        accumulator.Add("visitor", "1.2.3.4", Start.AddMinutes(31));
        accumulator.Add("owner", "1.2.3.4", Start.AddMinutes(50));
        Assert.Equal(3, accumulator.Value.All.Visits);
        Assert.Equal(2, accumulator.Value.All.Visitors);
        Assert.Equal(Start.AddMinutes(50), accumulator.Value.All.LastViewedAt);
        Assert.Equal(2, accumulator.Value.External.Visits);
        Assert.Equal(1, accumulator.Value.External.Visitors);
        Assert.Equal(Start.AddMinutes(31), accumulator.Value.External.LastViewedAt);
    }

    [Fact]
    public void AnonymousIpIsDistinctFromLoggedIdentityAndDoesNotGuessAuthor()
    {
        var accumulator = new HostedSiteTrafficAccumulator("owner");
        accumulator.Add("owner", "1.2.3.4", Start);
        accumulator.Add(null, "1.2.3.4", Start);
        accumulator.Add(null, "1.2.3.4", Start.AddMinutes(1));
        accumulator.Add("1.2.3.4", "9.9.9.9", Start);
        Assert.Equal(3, accumulator.Value.All.Visitors);
        Assert.Equal(2, accumulator.Value.External.Visitors);
        Assert.Equal(2, accumulator.Value.External.Visits);
    }

    [Fact]
    public void MissingHistoryIsZeroWithNoInventedLastAccess()
    {
        var traffic = new HostedSiteTrafficAccumulator("owner").Value;
        Assert.Equal(0, traffic.All.Visits);
        Assert.Equal(0, traffic.All.Visitors);
        Assert.Null(traffic.All.LastViewedAt);
        Assert.Equal(0, traffic.External.Visits);
        Assert.Null(traffic.External.LastViewedAt);
    }

    [Fact]
    public void LegacyCounterWithoutLogsDoesNotInventZeroTraffic()
    {
        var accumulator = new HostedSiteTrafficAccumulator("owner");
        Assert.NotNull(accumulator.Build(0));
        Assert.Null(accumulator.Build(7));
        accumulator.Add("owner", null, Start);
        Assert.NotNull(accumulator.Build(7));
    }
}
