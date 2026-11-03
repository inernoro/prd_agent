using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed partial class GatewayIncidentEpisodeDeliveryTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task DelayedSuccessSnapshot_CannotCloseNewerFailure(bool reopened)
    {
        await using var f = await Fixture.CreateAsync();
        await f.LogAsync("failure-zero", "failed", -180); await f.SweepAsync(); await f.DispatchAsync();
        await f.LogAsync("success-stale", "succeeded", -120);
        using var barrier = PauseLogSnapshot(f);
        var stale = f.SweepAsync();
        await barrier.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Exception? error;
        try
        {
            if (reopened) await f.SweepAsync(); // the same success is legitimately applied once
            await f.LogAsync("failure-newer", "failed", -60); await f.SweepAsync();
            if (reopened) { f.Clock.Advance(TimeSpan.FromMinutes(31)); await f.DispatchAsync(); }
            await TraceAsync(f, "before-stale-success", reopened);
        }
        finally { barrier.Release.TrySetResult(); }
        error = await Record.ExceptionAsync(() => stale);
        await TraceAsync(f, "after-stale-success", reopened);
        await f.SweepAsync();
        f.Clock.Advance(TimeSpan.FromMinutes(31)); await f.DispatchAsync();
        await TraceAsync(f, "after-reentry", reopened);
        Assert.Equal(reopened ? 1 : 0, (await f.FaultAsync()).PushEpisode);
        Assert.Equal(reopened ? 2 : 1, f.Http.Calls);
        Assert.Equal("open", (await f.FaultAsync()).Status);
        Assert.Null(error);
    }

    [Fact]
    public async Task DelayedFailureSnapshot_CannotReopenAfterNewerSuccess()
    {
        await using var f = await Fixture.CreateAsync();
        await f.LogAsync("failure-zero", "failed", -180); await f.SweepAsync(); await f.DispatchAsync();
        await f.LogAsync("failure-stale", "failed", -120);
        using var barrier = PauseLogSnapshot(f);
        var stale = f.SweepAsync();
        await barrier.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try
        {
            await f.LogAsync("success-newer", "succeeded", -60); await f.SweepAsync();
            f.Clock.Advance(TimeSpan.FromMinutes(6)); await f.DispatchAsync();
            await TraceAsync(f, "before-stale-failure", false);
        }
        finally { barrier.Release.TrySetResult(); }
        await stale;
        f.Clock.Advance(TimeSpan.FromMinutes(31)); await f.DispatchAsync();
        await TraceAsync(f, "after-stale-failure", false);
        Assert.Equal("closed", (await f.FaultAsync()).Status);
        Assert.Equal(0, (await f.FaultAsync()).PushEpisode);
        Assert.Equal(2, f.Http.Calls);
    }

    [Fact]
    public async Task SubscriptionEnabledBeforeReopen_LateBaselineCannotCoverNewEpisode()
    {
        await using var f = await Fixture.CreateAsync();
        await f.LogAsync("old-fault", "failed", -180); await f.SweepAsync(); await f.DispatchAsync();
        await f.LogAsync("old-recovery", "succeeded", -120); await f.SweepAsync();
        await f.Db.AdminPushSubscriptions.DeleteManyAsync(_ => true);
        using var barrier = PauseNotificationQuery(f);
        var enabling = f.SubscribeAsync();
        await barrier.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try
        {
            Assert.True(await f.Db.AdminPushSubscriptions.Find(s => s.Enabled).AnyAsync());
            await f.LogAsync("post-enable-failure", "failed", -60); await f.SweepAsync();
            await TraceAsync(f, "enabled-before-late-baseline", true);
        }
        finally { barrier.Release.TrySetResult(); }
        await enabling;
        f.Clock.Advance(TimeSpan.FromMinutes(31)); await f.DispatchAsync(); await f.DispatchAsync();
        await TraceAsync(f, "after-late-baseline", true);
        Assert.Equal(2, f.Http.Calls);
        Assert.Equal(1, (await f.FaultAsync()).PushEpisode);
        var id = (await f.FaultAsync()).Id;
        Assert.False(await f.Db.AdminPushDeliveryLogs.Find(l => l.NotificationId == id && l.Method == "BASELINE"
            && l.CoveredNotificationDeliveryKeys.Contains(id + ":episode:1")).AnyAsync());
    }

    [Fact]
    public async Task ClosedIncidentStillAdvancesSuccessWatermark()
    {
        await using var f = await Fixture.CreateAsync();
        await f.LogAsync("initial", "failed", -180); await f.SweepAsync();
        await f.LogAsync("success-one", "succeeded", -150); await f.SweepAsync();
        await f.LogAsync("failure-between-successes", "failed", -120);
        using var barrier = PauseLogSnapshot(f);
        var stale = f.SweepAsync();
        await barrier.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try { await f.LogAsync("success-two", "succeeded", -60); await f.SweepAsync(); }
        finally { barrier.Release.TrySetResult(); }
        await stale;
        Assert.Equal("closed", (await f.FaultAsync()).Status);
        Assert.Equal(0, (await f.FaultAsync()).PushEpisode);
        Assert.Equal(1, await f.Db.AdminNotifications.CountDocumentsAsync(n => n.Level == "success"));
    }

    [Fact]
    public async Task LegacyZeroEpisodeWithoutNewFields_AdoptsWatermark_AndRemainsHistory()
    {
        await using var f = await Fixture.CreateAsync();
        await f.LogAsync("legacy", "failed", -180); await f.SweepAsync();
        var fault = await f.FaultAsync();
        await f.Db.Database.GetCollection<BsonDocument>("admin_notifications").UpdateOneAsync(new BsonDocument("_id", fault.Id),
            new BsonDocument("$unset", new BsonDocument { { "GatewaySignalVersion", 1 }, { "PushEpisodeStartedAtUtcTicks", 1 }, { "PushEpisode", 1 } }));
        await f.SweepAsync();
        var adopted = await f.FaultAsync();
        Assert.False(string.IsNullOrEmpty(adopted.GatewaySignalVersion));
        Assert.Null(adopted.PushEpisodeStartedAtUtcTicks);
        await f.Db.AdminPushSubscriptions.DeleteManyAsync(_ => true);
        await f.SubscribeAsync(); await f.DispatchAsync();
        Assert.Equal(0, f.Http.Calls);
        await f.LogAsync("recovery", "succeeded", -120); await f.SweepAsync();
        await f.LogAsync("recurrence", "failed", -60); await f.SweepAsync();
        Assert.NotNull((await f.FaultAsync()).PushEpisodeStartedAtUtcTicks);
        f.Clock.Advance(TimeSpan.FromMinutes(31)); await f.DispatchAsync();
        Assert.Equal(1, f.Http.Calls);
    }

    [Fact]
    public void SameMongoMillisecond_UsesStableFailureFirstTieRule()
    {
        var ms = DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond * TimeSpan.TicksPerMillisecond;
        var failure = new LlmRequestLog { Id = "f", RequestId = "f", TenantId = "t", AppCallerCode = "a", Path = "/image",
            Provider = "gateway-auth", Status = "failed", StatusCode = 503, StartedAt = new DateTime(ms + 1, DateTimeKind.Utc) };
        var success = new LlmRequestLog { Id = "s", RequestId = "s", TenantId = "t", AppCallerCode = "a", Path = "/image",
            Provider = "fixture", Status = "succeeded", StatusCode = 200, StartedAt = new DateTime(ms + 9999, DateTimeKind.Utc) };
        var one = LlmGatewayIncidentPolicy.BuildSignals(new[] { failure, success }).Single(s => s.IsGatewayEntry);
        var reversed = LlmGatewayIncidentPolicy.BuildSignals(new[] { success, failure }).Single(s => s.IsGatewayEntry);
        Assert.True(one.IsFailure);
        Assert.Equal(one.SignalVersion, reversed.SignalVersion);
        success.StartedAt = new DateTime(ms + TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);
        Assert.False(LlmGatewayIncidentPolicy.BuildSignals(new[] { failure, success }).Single(s => s.IsGatewayEntry).IsFailure);
    }

    [Fact]
    public async Task EpisodeStartExactlyAtBaselineCutoff_IsNotAssumedHistorical()
    {
        await using var f = await Fixture.CreateAsync();
        await f.LogAsync("first", "failed", -180); await f.SweepAsync(); await f.DispatchAsync();
        await f.LogAsync("recovered", "succeeded", -120); await f.SweepAsync();
        await f.LogAsync("recurrence", "failed", -60); await f.SweepAsync();
        var fault = await f.FaultAsync();
        var subscription = await f.Db.AdminPushSubscriptions.Find(_ => true).SingleAsync();
        var push = new AdminPushNotificationService(f.Db, f.Http, new LoopbackOnlyValidator(),
            new ConfigurationBuilder().Build(), NullLogger<AdminPushNotificationService>.Instance, f.Clock);
        // Execute the real baseline method with its explicit cutoff parameter; no clock or product logic is replaced.
        await (Task)typeof(AdminPushNotificationService).GetMethod("MarkExistingNotificationsAsDeliveredAsync", BindingFlags.NonPublic | BindingFlags.Instance)!
            .Invoke(push, new object[] { subscription, new DateTime(fault.PushEpisodeStartedAtUtcTicks!.Value, DateTimeKind.Utc), CancellationToken.None })!;
        Assert.False(await f.Db.AdminPushDeliveryLogs.Find(l => l.NotificationId == fault.Id && l.Method == "BASELINE").AnyAsync());
        f.Clock.Advance(TimeSpan.FromMinutes(31)); await f.DispatchAsync();
        Assert.Equal(2, f.Http.Calls);
    }

    private static async Task TraceAsync(Fixture f, string step, bool reopened)
    {
        var fault = await f.FaultAsync();
        Console.WriteLine("ORDER_TRACE " + JsonSerializer.Serialize(new { step, reopened, fault.Status, fault.PushEpisode,
            signalVersion = typeof(AdminNotification).GetProperty("GatewaySignalVersion")?.GetValue(fault),
            episodeStartTicks = typeof(AdminNotification).GetProperty("PushEpisodeStartedAtUtcTicks")?.GetValue(fault),
            calls = f.Http.Calls }));
    }

    // Only the real Mongo read is held. Product entry points and transitions are unchanged.
    // A completed FindAsync has captured its first server batch; fixtures fit entirely in that batch.
    private static ReadBarrier PauseLogSnapshot(Fixture f)
    {
        var context = (LlmGatewayDataContext)typeof(Fixture).GetField("_gateway", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(f)!;
        var field = typeof(MongoDbContext).GetField("_llmRequestLogs", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var wrapped = DispatchProxy.Create<IMongoCollection<LlmRequestLog>, ReadBarrier>();
        var barrier = (ReadBarrier)(object)wrapped;
        barrier.Inner = field.GetValue(context.Context)!;
        barrier.AfterRead = true;
        field.SetValue(context.Context, wrapped);
        return barrier;
    }

    private static ReadBarrier PauseNotificationQuery(Fixture f)
    {
        var field = typeof(MongoDbContext).GetField("_database", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var wrapped = DispatchProxy.Create<IMongoDatabase, DatabaseBarrier>();
        var database = (DatabaseBarrier)(object)wrapped;
        database.Inner = (IMongoDatabase)field.GetValue(f.Db)!;
        field.SetValue(f.Db, wrapped);
        return database.Barrier;
    }

    public class ReadBarrier : DispatchProxy, IDisposable
    {
        public object Inner = null!;
        public bool AfterRead;
        private int _armed = 1;
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override object? Invoke(MethodInfo? method, object?[]? args)
        {
            if (method!.Name == "FindAsync" && Interlocked.Exchange(ref _armed, 0) == 1)
            {
                var projection = method.GetGenericArguments()[0];
                return typeof(ReadBarrier).GetMethod(nameof(HoldAsync), BindingFlags.NonPublic | BindingFlags.Instance)!
                    .MakeGenericMethod(projection).Invoke(this, new object[] { method, args! });
            }
            return method.Invoke(Inner, args);
        }
        private async Task<IAsyncCursor<T>> HoldAsync<T>(MethodInfo method, object?[] args)
        {
            IAsyncCursor<T>? cursor = null;
            if (AfterRead) cursor = await (Task<IAsyncCursor<T>>)method.Invoke(Inner, args)!;
            Entered.TrySetResult();
            await Release.Task.WaitAsync(TimeSpan.FromSeconds(20));
            return cursor ?? await (Task<IAsyncCursor<T>>)method.Invoke(Inner, args)!;
        }
        public void Dispose() => Release.TrySetResult();
    }

    public class DatabaseBarrier : DispatchProxy
    {
        public IMongoDatabase Inner = null!;
        private IMongoCollection<AdminNotification>? _collection;
        public ReadBarrier Barrier { get; } = new();
        protected override object? Invoke(MethodInfo? method, object?[]? args)
        {
            if (method!.Name == "GetCollection" && method.GetGenericArguments()[0] == typeof(AdminNotification))
            {
                if (_collection is null)
                {
                    _collection = DispatchProxy.Create<IMongoCollection<AdminNotification>, ReadBarrier>();
                    var actual = (ReadBarrier)(object)_collection;
                    // Share the barrier exposed to the test with this generated collection proxy.
                    actual.Inner = method.Invoke(Inner, args)!;
                    actual.Entered.Task.ContinueWith(_ => Barrier.Entered.TrySetResult(), TaskScheduler.Default);
                    Barrier.Release.Task.ContinueWith(_ => actual.Release.TrySetResult(), TaskScheduler.Default);
                }
                return _collection;
            }
            return method.Invoke(Inner, args);
        }
    }
}
