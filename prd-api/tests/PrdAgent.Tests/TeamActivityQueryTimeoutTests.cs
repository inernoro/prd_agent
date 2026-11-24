using System.Net;
using System.Text.Json;
using MongoDB.Bson;
using MongoDB.Driver;
using MongoDB.Driver.Core.Clusters;
using MongoDB.Driver.Core.Connections;
using MongoDB.Driver.Core.Servers;
using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Tests;

public class TeamActivityQueryTimeoutTests
{
    private static readonly ConnectionId Connection = new(
        new ServerId(new ClusterId(), new DnsEndPoint("localhost", 27017)));

    private static MongoCommandException CommandFailure(int code) =>
        new(Connection, "command failed", new BsonDocument("aggregate", "events"),
            new BsonDocument { { "ok", 0 }, { "code", code }, { "errmsg", "command failed" } });

    [Theory]
    [InlineData(50, true)]
    [InlineData(13, false)]
    [InlineData(59, false)]
    public void OnlyMaxTimeCommandFailuresUseTheQueryTimeoutResponse(int code, bool expected)
    {
        Assert.Equal(expected, TeamActivityQueryTimeout.IsTimeout(CommandFailure(code)));
    }

    [Fact]
    public void DriverExecutionTimeoutIsRecognizedButTransportFailuresAreNot()
    {
        Assert.True(TeamActivityQueryTimeout.IsTimeout(new MongoExecutionTimeoutException(Connection, "budget expired")));
        Assert.False(TeamActivityQueryTimeout.IsTimeout(new MongoConnectionException(Connection, "transport failed")));
    }

    [Fact]
    public async Task BriefTimeoutSendsOneRecoverableErrorWithThePublicCode()
    {
        var events = new List<(string Event, string Json)>();
        await TeamActivityQueryTimeout.SendSseErrorAsync((name, payload) =>
        {
            events.Add((name, JsonSerializer.Serialize(payload)));
            return Task.CompletedTask;
        });

        var sent = Assert.Single(events);
        Assert.Equal("error", sent.Event);
        using var json = JsonDocument.Parse(sent.Json);
        Assert.Equal("VOC_QUERY_TIMEOUT", json.RootElement.GetProperty("code").GetString());
        Assert.Contains("缩短时间范围后重试", json.RootElement.GetProperty("message").GetString());
    }

    [Fact]
    public async Task TrackingStartRecoversBeforeItsFiveMinuteCacheWouldExpire()
    {
        var cache = new TeamActivityQueryCache<DateTime>(TimeSpan.FromMinutes(5));
        var known = new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc);
        var reads = 0;
        var warnings = new List<MongoException>();
        Task<DateTime> Read() => ++reads == 1
            ? Task.FromException<DateTime>(CommandFailure(50))
            : Task.FromResult(known);

        Assert.Equal(default, await TeamActivityQueryTimeout.ReadTrackingStartAsync(cache, Read, warnings.Add));
        Assert.Single(warnings);
        Assert.Equal(known, await TeamActivityQueryTimeout.ReadTrackingStartAsync(cache, Read, warnings.Add));
        Assert.Equal(known, await TeamActivityQueryTimeout.ReadTrackingStartAsync(cache, Read, warnings.Add));
        Assert.Equal(2, reads);
    }

    [Fact]
    public async Task MaxTimeFailureDoesNotPoisonTheNextCachedQuery()
    {
        var cache = new TeamActivityQueryCache<int>(TimeSpan.FromSeconds(30));
        await Assert.ThrowsAsync<MongoCommandException>(() =>
            cache.GetAsync("today", () => Task.FromException<int>(CommandFailure(50))));
        Assert.Equal(7, await cache.GetAsync("today", () => Task.FromResult(7)));
    }
}
