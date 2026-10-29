using System.Net;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed partial class GatewayIncidentEpisodeDeliveryTests
{
    [Fact]
    public async Task RecoveryThenConcurrentReopen_SendsOneNewEpisode_AndKeepsHistory()
    {
        await using var f = await Fixture.CreateAsync();
        await f.LogAsync("first", "failed", -180);
        await f.SweepAsync(); await f.DispatchAsync();
        var original = await f.FaultAsync();
        Assert.Equal(0, original.PushEpisode);
        Assert.Equal(1, f.Http.Calls);
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => f.SweepAsync()));
        await f.DispatchAsync();
        Assert.Equal(1, f.Http.Calls);
        await f.LogAsync("continuous-newer", "failed", -150); await f.SweepAsync();
        Assert.Equal(original.PushEpisodeStartedAtUtcTicks, (await f.FaultAsync()).PushEpisodeStartedAtUtcTicks);
        await f.LogAsync("recovered", "succeeded", -120);
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => f.SweepAsync()));
        Assert.Equal("closed", (await f.FaultAsync()).Status);
        Assert.Equal(1, await f.Db.AdminNotifications.CountDocumentsAsync(n => n.Level == "success"));
        f.Clock.Advance(TimeSpan.FromMinutes(6)); await f.DispatchAsync();
        Assert.Equal(2, f.Http.Calls);
        await f.LogAsync("recurrence", "failed", -60);
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => f.SweepAsync()));
        var reopened = await f.FaultAsync();
        Assert.Equal(original.Id, reopened.Id);
        Assert.Equal(1, reopened.PushEpisode);
        Assert.Null(reopened.HandledAt);
        f.Clock.Advance(TimeSpan.FromMinutes(31));
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => f.DispatchAsync()));
        await f.SweepAsync(); await f.DispatchAsync();
        Assert.Equal(3, f.Http.Calls);
        var receipts = await f.Db.AdminPushDeliveryLogs.Find(l => l.NotificationId == original.Id).ToListAsync();
        Assert.Equal(2, receipts.Count);
        Assert.All(receipts, l => Assert.True(l.Success));
        Assert.Contains(original.Id + ":episode:0", receipts.SelectMany(l => l.CoveredNotificationDeliveryKeys));
        Assert.Contains(original.Id + ":episode:1", receipts.SelectMany(l => l.CoveredNotificationDeliveryKeys));
    }

    [Theory]
    [InlineData("accepted", false)]
    [InlineData("accepted", true)]
    [InlineData("unconfirmed", false)]
    [InlineData("unconfirmed", true)]
    [InlineData("reserved", false)]
    [InlineData("reserved", true)]
    [InlineData("failed", false)]
    public async Task LegacyReceipts_StayTerminalForOldEpisode_ButDoNotCoverRecoveredEpisode(string state, bool batch)
    {
        await using var f = await Fixture.CreateAsync();
        await f.LogAsync("old-failure", "failed", -180); await f.SweepAsync();
        var fault = await f.FaultAsync();
        var notices = f.Db.Database.GetCollection<BsonDocument>("admin_notifications");
        var logs = f.Db.Database.GetCollection<BsonDocument>("admin_push_delivery_logs");
        await notices.UpdateOneAsync(new BsonDocument("_id", fault.Id), new BsonDocument("$unset", new BsonDocument("PushEpisode", 1)));
        for (var i = 0; i < (state == "failed" ? 3 : 1); i++)
            await logs.InsertOneAsync(new BsonDocument {
                { "_id", "legacy-" + i }, { "UserId", "fixture-user" }, { "TopicKey", "api-request-alert" },
                { "NotificationId", batch ? "legacy-batch" : fault.Id },
                { "CoveredNotificationIds", batch ? new BsonArray { fault.Id } : new BsonArray() },
                { "DeliveryState", state }, { "Success", state == "accepted" },
                { "CreatedAt", f.Clock.GetUtcNow().UtcDateTime.AddHours(-1) }
            });
        var before = (await logs.Find(new BsonDocument()).ToListAsync()).Select(x => x.ToJson()).ToArray();
        await f.DispatchAsync();
        Assert.Equal(0, f.Http.Calls);
        await f.LogAsync("real-recovery", "succeeded", -120); await f.SweepAsync();
        await f.LogAsync("new-failure", "failed", -60);
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => f.SweepAsync()));
        Assert.Equal(1, (await f.FaultAsync()).PushEpisode);
        f.Clock.Advance(TimeSpan.FromMinutes(31)); await f.DispatchAsync(); await f.DispatchAsync();
        // Recovery and current fault share one route and are sent in one batch.
        Assert.Equal(1, f.Http.Calls);
        Assert.Contains(fault.Id + ":episode:1", (await f.Db.AdminPushDeliveryLogs.Find(l => l.Success && l.Id != "legacy-0").ToListAsync())
            .SelectMany(l => l.CoveredNotificationDeliveryKeys));
        var after = (await logs.Find(new BsonDocument("_id", new BsonDocument("$in", new BsonArray(Enumerable.Range(0, before.Length).Select(i => "legacy-" + i))))).ToListAsync()).Select(x => x.ToJson()).ToArray();
        Assert.Equal(before, after);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RecoveryAndReopenDuringSend_OldCompletionCannotCoverNewEpisode(bool unknown)
    {
        await using var f = await Fixture.CreateAsync();
        f.Http.BlockFirst = true; f.Http.ThrowFirst = unknown;
        await f.LogAsync("old-inflight", "failed", -180); await f.SweepAsync();
        var sending = f.DispatchAsync();
        AdminNotification fault = null!;
        AdminPushDeliveryLog reservation = null!;
        try
        {
            await f.Http.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            fault = await f.FaultAsync();
            reservation = await f.Db.AdminPushDeliveryLogs.Find(_ => true).SingleAsync();
            Assert.Equal("reserved", reservation.DeliveryState);
            await f.LogAsync("recover-during-send", "succeeded", -120); await f.SweepAsync();
            await f.LogAsync("recur-during-send", "failed", -60);
            await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => f.SweepAsync()));
            Assert.Equal(1, (await f.FaultAsync()).PushEpisode);
        }
        finally { f.Http.Release.TrySetResult(); await sending; }
        var completed = await f.Db.AdminPushDeliveryLogs.Find(l => l.Id == reservation.Id).SingleAsync();
        Assert.Equal(unknown ? "unconfirmed" : "accepted", completed.DeliveryState);
        Assert.Equal(new[] { fault.Id + ":episode:0" }, completed.CoveredNotificationDeliveryKeys);
        f.Clock.Advance(TimeSpan.FromMinutes(31));
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => f.DispatchAsync()));
        Assert.Equal(2, f.Http.Calls);
        f.Clock.Advance(TimeSpan.FromHours(2)); await f.DispatchAsync();
        Assert.Equal(2, f.Http.Calls);
        Assert.Equal(2, await f.Db.AdminPushDeliveryLogs.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task CurrentEpisodeUnconfirmed_IsNotReplayedAfterRestartOrWindowExpiry()
    {
        await using var f = await Fixture.CreateAsync();
        f.Http.ThrowFirst = true;
        await f.LogAsync("first-unknown", "failed", -180); await f.SweepAsync(); await f.DispatchAsync();
        await f.LogAsync("real-recovery", "succeeded", -120); await f.SweepAsync();
        await f.LogAsync("new-unknown", "failed", -60); await f.SweepAsync();
        f.Http.ThrowAll = true;
        f.Clock.Advance(TimeSpan.FromMinutes(31)); await f.DispatchAsync();
        Assert.Equal(2, f.Http.Calls);
        f.Clock.Advance(TimeSpan.FromHours(2)); await f.DispatchAsync();
        Assert.Equal(2, f.Http.Calls);
        Assert.All(await f.Db.AdminPushDeliveryLogs.Find(_ => true).ToListAsync(), l => Assert.Equal("unconfirmed", l.DeliveryState));
    }

    [Fact]
    public async Task NewSubscriptionBaselinesCurrentEpisode_WithoutCoveringFutureRecoveryEpisode()
    {
        await using var f = await Fixture.CreateAsync();
        await f.LogAsync("initial", "failed", -180); await f.SweepAsync(); await f.DispatchAsync();
        await f.LogAsync("recovery-one", "succeeded", -120); await f.SweepAsync();
        await f.LogAsync("recurrence-one", "failed", -60); await f.SweepAsync();
        var fault = await f.FaultAsync();
        Assert.Equal(1, fault.PushEpisode);
        await f.Db.AdminPushSubscriptions.DeleteManyAsync(_ => true);
        await f.SubscribeAsync();
        await f.DispatchAsync();
        Assert.Equal(1, f.Http.Calls);
        var baseline = await f.Db.AdminPushDeliveryLogs.Find(l => l.NotificationId == fault.Id && l.Method == "BASELINE").SingleAsync();
        Assert.Equal(new[] { fault.Id + ":episode:1" }, baseline.CoveredNotificationDeliveryKeys);
        await f.LogAsync("recovery-two", "succeeded", -45); await f.SweepAsync();
        await f.LogAsync("recurrence-two", "failed", -30); await f.SweepAsync();
        Assert.Equal(2, (await f.FaultAsync()).PushEpisode);
        f.Clock.Advance(TimeSpan.FromMinutes(31)); await f.DispatchAsync(); await f.DispatchAsync();
        Assert.Equal(2, f.Http.Calls);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly LlmGatewayDataContext _gateway;
        private readonly IConfiguration _configuration;
        private readonly DateTime _logBase = DateTime.UtcNow;
        public MongoDbContext Db { get; }
        public TestClock Clock { get; } = new();
        public TestHttp Http { get; } = new();
        private Fixture(string uri, string databaseName)
        {
            _client = new MongoClient(uri);
            Db = new MongoDbContext(uri, databaseName);
            _gateway = new LlmGatewayDataContext(uri, databaseName);
            _configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> {
                ["LlmGateway:InternalTenantId"] = "episode-fixture",
                ["ServerUrl"] = "http://127.0.0.1:18991"
            }).Build();
        }
        public static async Task<Fixture> CreateAsync()
        {
            var uri = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                ?? Environment.GetEnvironmentVariable("ADMIN_PUSH_TEST_MONGO_URI") ?? "mongodb://localhost:27018";
            var f = new Fixture(uri, "prdagent_episode_test_" + Guid.NewGuid().ToString("N"));
            await f.Db.AdminPushSubscriptions.InsertOneAsync(new AdminPushSubscription {
                UserId = "fixture-user", TopicKey = "api-request-alert", Enabled = true,
                ChannelType = "url", Method = "GET", UrlTemplate = "http://127.0.0.1:18991/fake"
            });
            return f;
        }
        public Task LogAsync(string id, string status, int seconds) => _gateway.LlmRequestLogs.InsertOneAsync(new LlmRequestLog {
            Id = id, RequestId = id, TenantId = "episode-fixture", AppCallerCode = "fixture.image",
            Path = "/v1/images/generations", Provider = status == "failed" ? "gateway-auth" : "fixture",
            Status = status, StatusCode = status == "failed" ? 503 : 200, Model = status == "failed" ? "" : "fake-image",
            StartedAt = _logBase.AddSeconds(seconds), RequestType = "image"
        });
        public async Task SweepAsync()
        {
            using var watchdog = new LlmGatewayIncidentWatchdog(_gateway, Db, new AdminPushDispatchSignal(), _configuration,
                NullLogger<LlmGatewayIncidentWatchdog>.Instance);
            await watchdog.SweepOnceAsync(default);
        }
        public Task DispatchAsync() => new AdminPushNotificationService(Db, Http, new LoopbackOnlyValidator(), _configuration,
            NullLogger<AdminPushNotificationService>.Instance, Clock).DispatchPendingAsync(default);
        public Task<AdminPushSubscription> SubscribeAsync() => new AdminPushNotificationService(Db, Http, new LoopbackOnlyValidator(), _configuration,
            NullLogger<AdminPushNotificationService>.Instance, Clock).UpsertSubscriptionAsync("fixture-user", new AdminPushSubscriptionUpsertRequest {
                TopicKey = "api-request-alert", Enabled = true, ChannelType = "url", Method = "GET", UrlTemplate = "http://127.0.0.1:18991/fake"
            }, default);
        public Task<AdminNotification> FaultAsync() => Db.AdminNotifications.Find(n => n.Level == "error").SingleAsync();
        public async ValueTask DisposeAsync() { Http.Release.TrySetResult(); await _client.DropDatabaseAsync(Db.Database.DatabaseNamespace.DatabaseName); }
    }
    private sealed class TestClock : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan span) => _now += span;
    }
    private sealed class TestHttp : IHttpClientFactory
    {
        public int Calls;
        public bool BlockFirst, ThrowFirst, ThrowAll;
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public HttpClient CreateClient(string name) => new(new Handler(this));
        private sealed class Handler(TestHttp owner) : HttpMessageHandler
        {
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                Assert.Equal("127.0.0.1", request.RequestUri!.Host);
                var call = Interlocked.Increment(ref owner.Calls);
                owner.Entered.TrySetResult();
                if (call == 1 && owner.BlockFirst) await owner.Release.Task.WaitAsync(TimeSpan.FromSeconds(15));
                if (owner.ThrowAll || call == 1 && owner.ThrowFirst) throw new HttpRequestException("fixture: unknown delivery outcome");
                return new HttpResponseMessage(HttpStatusCode.OK);
            }
        }
    }
    private sealed class LoopbackOnlyValidator : ISafeOutboundUrlValidator
    {
        public bool IsSafeAddress(IPAddress address) => IPAddress.IsLoopback(address);
        public Task<Uri> EnsureSafeHttpUrlAsync(string? url, string purpose, CancellationToken ct = default)
        {
            var uri = new Uri(url!); Assert.Equal("127.0.0.1", uri.Host); return Task.FromResult(uri);
        }
    }
}
