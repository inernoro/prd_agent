using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed partial class GatewayIncidentEpisodeDeliveryTests
{
    [Fact]
    public async Task LegacyClosedRows_LatestRowReceivesSuccessWatermark_BeforeDelayedFailure()
    {
        await using var f = await Fixture.CreateAsync();
        var gateway = (LlmGatewayDataContext)typeof(Fixture)
            .GetField("_gateway", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(f)!;
        await f.LogAsync("legacy-initial", "failed", -240);
        var initial = Assert.Single(LlmGatewayIncidentPolicy.BuildSignals(
            await gateway.LlmRequestLogs.Find(_ => true).ToListAsync()), x => x.IsGatewayEntry);
        var now = f.Clock.GetUtcNow().UtcDateTime;
        var older = new AdminNotification {
            Id = "legacy-older", Key = "llmgw-upstream:" + initial.Fingerprint, Source = "gateway-alert",
            Status = "closed", Level = "error", Title = "旧历史", Message = "保留旧历史",
            CreatedAt = now.AddMinutes(-10), GatewaySignalVersion = initial.SignalVersion,
        };
        var current = new AdminNotification {
            Id = "legacy-current", Key = older.Key, Source = "gateway-alert",
            Status = "open", Level = "error", Title = "当前故障", Message = "当前故障",
            CreatedAt = now.AddMinutes(-5), GatewaySignalVersion = initial.SignalVersion,
        };
        // 真实历史插入顺序：旧行在前、最新行在后；Key并非唯一键。
        await f.Db.AdminNotifications.InsertManyAsync([older, current]);
        await f.DispatchAsync();
        Assert.Equal(1, f.Http.Calls);
        await f.LogAsync("legacy-success-one", "succeeded", -180); await f.SweepAsync();
        var oldSnapshot = (await f.Db.AdminNotifications.Find(x => x.Id == older.Id).SingleAsync()).ToBsonDocument().ToJson();
        var receiptSnapshot = (await f.Db.AdminPushDeliveryLogs.Find(_ => true).ToListAsync()).Select(x => x.ToBsonDocument().ToJson()).ToArray();
        await f.LogAsync("legacy-delayed-failure", "failed", -120);
        using var barrier = PauseLogSnapshot(f);
        var stale = f.SweepAsync();
        await barrier.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        string successWatermark;
        try
        {
            await f.LogAsync("legacy-success-two", "succeeded", -60);
            successWatermark = Assert.Single(LlmGatewayIncidentPolicy.BuildSignals(
                await gateway.LlmRequestLogs.Find(x => x.RequestId == "legacy-success-two").ToListAsync()), x => x.IsGatewayEntry).SignalVersion;
            await f.SweepAsync();
            var afterSuccess = await f.Db.AdminNotifications.Find(x => x.Key == older.Key)
                .SortBy(x => x.CreatedAt).ToListAsync();
            Console.WriteLine("LEGACY_CURRENT_ROW_TRACE " + JsonSerializer.Serialize(new {
                expectedSuccessWatermark = successWatermark,
                rows = afterSuccess.Select(x => new { x.Id, x.Status, x.GatewaySignalVersion, x.PushEpisode }),
            }));
        }
        finally { barrier.Release.TrySetResult(); }
        await stale;
        var after = await f.Db.AdminNotifications.Find(x => x.Id == current.Id).SingleAsync();
        Assert.Equal("closed", after.Status);
        Assert.Equal(0, after.PushEpisode);
        Assert.Equal(successWatermark, after.GatewaySignalVersion);
        Assert.Equal(oldSnapshot, (await f.Db.AdminNotifications.Find(x => x.Id == older.Id).SingleAsync()).ToBsonDocument().ToJson());
        Assert.Equal(2, await f.Db.AdminNotifications.CountDocumentsAsync(x => x.Key == older.Key));
        Assert.Equal(receiptSnapshot, (await f.Db.AdminPushDeliveryLogs.Find(_ => true).ToListAsync()).Select(x => x.ToBsonDocument().ToJson()).ToArray());
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(1, 1)]
    public async Task LegacyUrgentMemory_OnlyCoversEpisodeZero_NotARealRecurrence(int episode, int expectedCalls)
    {
        await using var f = await Fixture.CreateAsync();
        await f.LogAsync("legacy-continuous", "failed", -180); await f.SweepAsync();
        var fault = await f.FaultAsync();
        await f.Db.AdminNotifications.UpdateOneAsync(x => x.Id == fault.Id, Builders<AdminNotification>.Update
            .Set(x => x.CreatedAt, f.Clock.GetUtcNow().UtcDateTime.AddMinutes(-15)));
        if (episode > 0)
        {
            await f.LogAsync("legacy-recovery", "succeeded", -120); await f.SweepAsync();
            await f.LogAsync("legacy-real-recurrence", "failed", -60); await f.SweepAsync();
            var recurrence = await f.FaultAsync();
            Assert.Equal(fault.Id, recurrence.Id);
            Assert.Equal(1, recurrence.PushEpisode);
        }
        var now = f.Clock.GetUtcNow().UtcDateTime;
        var legacyKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(new[] { fault.Source, fault.Id }))));
        var failed = new AdminPushDeliveryLog {
            Id = "legacy-explicit-failure", UserId = "fixture-user", TopicKey = "api-request-alert",
            NotificationId = fault.Id, CoveredNotificationIds = [fault.Id], Success = false,
            DeliveryState = "failed", CreatedAt = now.AddMinutes(-11),
        };
        await f.Db.AdminPushDeliveryLogs.InsertOneAsync(failed);
        var failedSnapshot = failed.ToBsonDocument().ToJson();
        var attempts = new BsonArray {
            new BsonDocument { { "at", now.AddSeconds(-120) }, { "urgent", false } },
            new BsonDocument { { "at", now.AddSeconds(-61) }, { "urgent", false } },
        };
        var states = f.Db.Database.GetCollection<BsonDocument>("admin_push_dispatch_state");
        await states.InsertOneAsync(new BsonDocument {
            { "_id", "fixture-user" }, { "leaseUntil", DateTime.UnixEpoch },
            { "attemptHistory", attempts }, { "urgentIncidents", new BsonDocument(legacyKey, now.AddMinutes(-11)) },
        });
        await f.DispatchAsync();
        Assert.Equal(expectedCalls, f.Http.Calls);
        var state = await states.Find(_ => true).SingleAsync();
        Assert.Equal(2, state["attemptHistory"].AsBsonArray.Count(x => !x["urgent"].AsBoolean));
        Assert.Equal(expectedCalls, state["attemptHistory"].AsBsonArray.Count(x => x["urgent"].AsBoolean));
        Assert.True(state["attemptHistory"].AsBsonArray.Count <= 7);
        Assert.Equal(new BsonDateTime(now.AddMinutes(-11)), state["urgentIncidents"][legacyKey]);
        Assert.Equal(failedSnapshot, (await f.Db.AdminPushDeliveryLogs.Find(x => x.Id == failed.Id).SingleAsync()).ToBsonDocument().ToJson());
        if (episode > 0)
            Assert.True(await f.Db.AdminPushDeliveryLogs.Find(x => x.Success
                && x.CoveredNotificationDeliveryKeys.Contains(fault.Id + ":episode:1")).AnyAsync());
        await f.DispatchAsync();
        Assert.Equal(expectedCalls, f.Http.Calls);
    }
}
