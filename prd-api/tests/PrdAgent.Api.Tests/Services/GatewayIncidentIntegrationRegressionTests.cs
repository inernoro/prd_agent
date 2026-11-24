using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed partial class GatewayIncidentEpisodeDeliveryTests
{
    [Fact]
    public async Task Integration_ReopenedGatewayEpisodeUsesUrgentBudgetAfterOrdinaryBudgetExhaustion()
    {
        await using var f = await Fixture.CreateAsync();
        for (var i = 0; i < 2; i++)
        {
            await f.Db.AdminNotifications.InsertOneAsync(new AdminNotification {
                Id = "ordinary-" + i, Key = "ordinary-" + i, Level = "warning", Source = "gateway-alert",
                Title = "普通通知", Message = "已有普通配额", Status = "open",
                CreatedAt = f.Clock.GetUtcNow().UtcDateTime.AddMinutes(-1),
            });
            await f.DispatchAsync();
            f.Clock.Advance(TimeSpan.FromSeconds(61));
        }
        Assert.Equal(2, f.Http.Calls);
        await f.LogAsync("episode-zero", "failed", -180); await f.SweepAsync(); await f.DispatchAsync();
        Assert.Equal(3, f.Http.Calls);
        var original = await f.FaultAsync();
        await f.LogAsync("recovery", "succeeded", -120); await f.SweepAsync();
        await f.LogAsync("recurrence", "failed", -60); await f.SweepAsync();
        var reopened = await f.FaultAsync();
        Assert.Equal(original.Id, reopened.Id);
        Assert.Equal(original.PushEpisode + 1, reopened.PushEpisode);
        f.Clock.Advance(TimeSpan.FromSeconds(61));
        await f.DispatchAsync();
        Assert.Equal(4, f.Http.Calls);
        var budget = await f.Db.Database.GetCollection<BsonDocument>("admin_push_dispatch_state")
            .Find(_ => true).SingleAsync();
        var attempts = budget["attemptHistory"].AsBsonArray;
        Assert.Equal(2, attempts.Count(x => !x["urgent"].AsBoolean));
        Assert.Equal(2, attempts.Count(x => x["urgent"].AsBoolean));
        Assert.True(attempts.Count <= 7);
        Assert.True(await f.Db.AdminPushDeliveryLogs.Find(x => x.Success
            && x.CoveredNotificationDeliveryKeys.Contains(reopened.Id + ":episode:" + reopened.PushEpisode)).AnyAsync());
        await f.DispatchAsync();
        Assert.Equal(4, f.Http.Calls);
    }

    [Fact]
    public void Integration_LongFailureIsNotHiddenByLaterStartedEarlierCompletedSuccess()
    {
        var now = DateTime.UtcNow;
        LlmRequestLog Log(string id, string status, DateTime started, DateTime ended) => new() {
            Id = id, RequestId = id, Status = status, StatusCode = status == "failed" ? 502 : 200,
            TenantId = "completion-fixture", Provider = "fixture", Model = "fixture-model",
            StartedAt = started, EndedAt = ended,
        };
        var signal = Assert.Single(PrdAgent.Api.Services.LlmGatewayIncidentPolicy.BuildSignals([
            Log("long-failure", "failed", now.AddMinutes(-2), now),
            Log("short-success", "succeeded", now.AddMinutes(-1), now.AddSeconds(-30)),
        ]));
        Assert.True(signal.IsFailure);
        Assert.Equal("long-failure", signal.RequestId);
    }
}
