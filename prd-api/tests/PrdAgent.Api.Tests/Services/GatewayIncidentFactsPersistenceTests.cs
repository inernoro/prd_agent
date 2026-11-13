using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class GatewayIncidentFactsPersistenceTests
{
    [Fact]
    public async Task Repeated182Observations_AccumulateOnceAcrossConcurrentSweeps()
    {
        await using var f = new Fixture();
        var start = RecentStart();
        var logs = Enumerable.Range(0, 182).Select(i =>
        {
            var log = GatewayIncidentFactsTests.Request("quota-" + i, "failed", 402);
            log.StartedAt = start.AddMilliseconds(i * 10);
            log.EndedAt = log.StartedAt.AddMilliseconds(1);
            log.Error = "insufficient_balance";
            return log;
        }).ToList();
        await f.Gateway.LlmRequestLogs.InsertManyAsync(logs);
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => f.SweepAsync()));
        await f.SweepAsync();
        var notice = Assert.Single(await f.Notices());
        Assert.Equal(182, notice.OccurrenceCount);
        Assert.Equal(logs[0].EndedAt, notice.FirstOccurredAt);
        Assert.Equal(logs[^1].EndedAt, notice.LastOccurredAt);
        Assert.Equal("active", notice.IncidentState);
        Assert.Equal("request_failed", notice.RequestOutcome);
        Assert.Equal(0, notice.PushEpisode);
        Assert.Contains("primary", notice.Title);
        Assert.Contains("future-model-z", notice.Title);
        Assert.Contains("quota-181", notice.ActionUrl);
    }

    [Fact]
    public async Task FallbackSuccess_IsPersistedAsRequestSuccessAndActiveRouteFailure()
    {
        await using var f = new Fixture();
        var log = await f.Fallback("fallback", 0);
        await f.SweepAsync();
        var notice = Assert.Single(await f.Notices());
        Assert.Equal("fallback_succeeded", notice.RequestOutcome);
        Assert.Equal("warning", notice.Level);
        Assert.Equal("active", notice.IncidentState);
        Assert.Null(notice.RecoveredAt);
        Assert.Contains("已由备用线路成功完成", notice.Message);
        Assert.Contains("无需重试", notice.Message);
        Assert.Contains("primary", notice.Title);
        Assert.Equal(log.RequestId, notice.EvidenceRequestId);
    }

    [Fact]
    public async Task Acknowledgement_DoesNotRepairTheIncident_OrCreateARecurrence()
    {
        await using var f = new Fixture();
        await f.Failure("failure", 0);
        await f.SweepAsync();
        var notice = Assert.Single(await f.Notices());
        await f.Map.AdminNotifications.UpdateOneAsync(x => x.Id == notice.Id,
            Builders<AdminNotification>.Update.Set(x => x.Status, "closed").Set(x => x.HandledAt, DateTime.UtcNow));
        await f.Failure("still-failing", 1);
        await f.SweepAsync();
        var current = Assert.Single(await f.Notices());
        Assert.Equal("closed", current.Status);
        Assert.Equal("active", current.IncidentState);
        Assert.Null(current.RecoveredAt);
        Assert.Equal(0, current.PushEpisode);
        Assert.Equal(2, current.OccurrenceCount);
    }

    [Fact]
    public async Task RecoveryAndRecurrence_InOneSweep_KeepTheLifecycleAndIdentity()
    {
        await using var f = new Fixture();
        await f.Failure("first", 0);
        var success = f.Request("recovered", "succeeded", 200, 1);
        await f.Gateway.LlmRequestLogs.InsertOneAsync(success);
        await f.Failure("recurrence", 2);
        await f.SweepAsync();
        var notices = await f.Notices();
        var active = Assert.Single(notices, n => n.Level == "error");
        Assert.Equal(2, active.OccurrenceCount);
        Assert.Equal(1, active.PushEpisode);
        Assert.Equal("open", active.Status);
        Assert.Equal("active", active.IncidentState);
        Assert.Null(active.RecoveredAt);
        var recovered = Assert.Single(notices, n => n.Level == "success");
        Assert.Equal("recovered", recovered.IncidentState);
        Assert.Equal(success.EndedAt, recovered.RecoveredAt);
        Assert.Equal(active.IncidentId, recovered.IncidentId);
        await f.SweepAsync();
        Assert.Equal(2, (await f.Notices()).Count);
    }

    [Fact]
    public async Task SameRouteSuccess_RecoversPersistedFaultEvenWhenFailureLeftTheLookback()
    {
        await using var f = new Fixture();
        await f.Failure("old-failure", 0);
        await f.SweepAsync();
        await f.Gateway.LlmRequestLogs.DeleteManyAsync(_ => true);
        var success = f.Request("new-success", "succeeded", 200, 1);
        await f.Gateway.LlmRequestLogs.InsertOneAsync(success);
        await f.SweepAsync();
        var failed = Assert.Single(await f.Notices(), n => n.Level == "error");
        Assert.Equal("recovered", failed.IncidentState);
        Assert.Equal("closed", failed.Status);
        Assert.Equal(success.EndedAt, failed.RecoveredAt);
        Assert.Equal(success.RequestId, failed.EvidenceRequestId);
    }

    [Fact]
    public async Task FullObservedAttemptFailure_AndUnfinishedFallback_AreDifferentOutcomes()
    {
        await using var f = new Fixture();
        var failed = f.Request("all-attempted-failed", "failed", 402, 0);
        failed.Error = "insufficient_balance";
        failed.ProviderAttempts = [f.Attempt("primary", "failed", 402, 0, 0), f.Attempt("backup", "failed", 402, 1, 0)];
        await f.Gateway.LlmRequestLogs.InsertOneAsync(failed);
        await f.SweepAsync();
        var notices = await f.Notices();
        Assert.Equal(2, notices.Count);
        Assert.All(notices, n => { Assert.Equal("all_failed", n.RequestOutcome); Assert.Contains("本次已尝试的 2 条线路均失败", n.Message); });
        var pending = f.Request("unfinished", "running", 0, 1);
        pending.ProviderAttempts = [f.Attempt("primary", "failed", 402, 0, 1), f.Attempt("backup", "selected", 0, 1, 1)];
        await f.Gateway.LlmRequestLogs.InsertOneAsync(pending);
        await f.SweepAsync();
        var primary = Assert.Single(await f.Notices(), n => n.Title.Contains("primary"));
        Assert.Equal("unknown", primary.RequestOutcome);
        Assert.Contains("结果尚未确认", primary.Message);
        Assert.Equal("active", primary.IncidentState);
    }

    [Fact]
    public async Task ImpactEscalation_CreatesOneDeliveryEpisodeWithoutDuplicatingTheFault()
    {
        await using var f = new Fixture();
        await f.Fallback("completed-on-backup", 0);
        await f.SweepAsync();
        var before = Assert.Single(await f.Notices());
        await f.Failure("request-failed", 1);
        await f.SweepAsync(); await f.SweepAsync();
        var after = Assert.Single(await f.Notices());
        Assert.Equal(before.Id, after.Id);
        Assert.Equal("request_failed", after.RequestOutcome);
        Assert.Equal(1, after.PushEpisode);
        Assert.Equal(2, after.OccurrenceCount);
    }

    [Fact]
    public async Task PendingOutcome_IsUpdatedWhenBackupCompletes_WithoutCountingTheFailureAgain()
    {
        await using var f = new Fixture();
        var log = f.Request("pending-outcome", "running", 0, 0);
        log.EndedAt = null;
        log.ProviderAttempts = [f.Attempt("primary", "failed", 402, 0, 0), f.Attempt("backup", "selected", 0, 1, 0)];
        await f.Gateway.LlmRequestLogs.InsertOneAsync(log);
        await f.SweepAsync();
        var before = Assert.Single(await f.Notices());
        Assert.Equal("unknown", before.RequestOutcome);
        log.Status = "succeeded"; log.PlatformId = "backup"; log.PlatformName = "backup";
        log.StartedAt = DateTime.UtcNow.AddMinutes(-20);
        log.EndedAt = DateTime.UtcNow;
        log.ProviderAttempts[1] = f.Attempt("backup", "succeeded", 200, 1, 1);
        await f.Gateway.LlmRequestLogs.ReplaceOneAsync(x => x.Id == log.Id, log);
        await f.SweepAsync();
        var after = Assert.Single(await f.Notices());
        Assert.Equal(before.Id, after.Id);
        Assert.Equal("fallback_succeeded", after.RequestOutcome);
        Assert.Equal(1, after.OccurrenceCount);
        Assert.Equal("active", after.IncidentState);
        Assert.Null(after.RecoveredAt);
    }

    [Fact]
    public async Task Review_RecoveryPreservesAccumulated182FailureFacts()
    {
        await using var f = new Fixture();
        var logs = Enumerable.Range(0, 182).Select(i => {
            var log = f.Request("repeated-" + i, "failed", 402, 0);
            log.EndedAt = log.EndedAt!.Value.AddMilliseconds(i);
            log.Error = "insufficient_balance";
            return log;
        }).ToList();
        await f.Gateway.LlmRequestLogs.InsertManyAsync(logs);
        await f.SweepAsync();
        var fault = Assert.Single(await f.Notices());
        Assert.Equal(182, fault.OccurrenceCount);
        var success = f.Request("confirmed-recovery", "succeeded", 200, 1);
        await f.Gateway.LlmRequestLogs.InsertOneAsync(success);
        await f.SweepAsync();
        var recovered = Assert.Single(await f.Notices(), x => x.Level == "success");
        Assert.Equal(fault.IncidentId, recovered.IncidentId);
        Assert.Equal(fault.OccurrenceCount, recovered.OccurrenceCount);
        Assert.Equal(fault.FirstOccurredAt, recovered.FirstOccurredAt);
        Assert.Equal(fault.LastOccurredAt, recovered.LastOccurredAt);
        Assert.Equal(success.EndedAt, recovered.RecoveredAt);
    }

    [Fact]
    public async Task Review_LegacyRouteMigration_RemainsVisibleWithoutMergingScopesOrClaimingRecovery()
    {
        await using var f = new Fixture();
        var log = f.Request("scoped-failure", "failed", 503, 0);
        log.TeamId = "new-team"; log.SourceDeployment = "isolated-preview";
        var legacy = LegacyRouteNotice(log);
        await f.Map.AdminNotifications.InsertOneAsync(legacy);
        await f.Gateway.LlmRequestLogs.InsertOneAsync(log);
        await f.SweepAsync();
        var rows = await f.Notices();
        var active = Assert.Single(rows, x => x.IncidentState == "active");
        Assert.NotEqual(legacy.Id, active.Id);
        Assert.Equal("active", active.IncidentState);
        Assert.Equal(1, active.OccurrenceCount);
        Assert.Equal(log.EndedAt, active.FirstOccurredAt);
        Assert.Equal(log.EndedAt, active.LastOccurredAt);
        Assert.Single(rows, x => !string.IsNullOrWhiteSpace(x.IncidentId));
        var retired = Assert.Single(rows, x => x.Id == legacy.Id);
        Assert.Equal(legacy.Key, retired.Key);
        Assert.Equal("open", retired.Status);
        Assert.Equal("unknown", retired.IncidentState);
        Assert.Null(retired.RecoveredAt);
        Assert.Null(retired.HandledAt);
        Assert.Null(retired.ExpiresAt);
        Assert.Null(retired.IncidentId);
        Assert.Equal(legacy.CreatedAt, retired.CreatedAt);
        Assert.Equal(legacy.UpdatedAt, retired.UpdatedAt);
        Assert.Equal(legacy.OccurrenceCount, retired.OccurrenceCount);
        Assert.Null(retired.FirstOccurredAt);
        Assert.Null(retired.LastOccurredAt);
        Assert.Contains("不代表", retired.Message);
        var other = f.Request("other-deployment-success", "succeeded", 200, 1);
        other.TeamId = log.TeamId; other.SourceDeployment = "another-preview";
        await f.Gateway.LlmRequestLogs.InsertOneAsync(other);
        await f.SweepAsync();
        Assert.Equal("active", (await f.Notices()).Single(x => x.Id == active.Id).IncidentState);
        var after = await f.Notices();
        Assert.Equal(2, after.Count);
        Assert.Equal("unknown", after.Single(x => x.Id == legacy.Id).IncidentState);
        Assert.Equal("open", after.Single(x => x.Id == legacy.Id).Status);
    }

    [Fact]
    public async Task Review_LegacyRouteWithoutRecentLog_RemainsVisibleAsUnknown()
    {
        await using var f = new Fixture();
        var legacy = LegacyRouteNotice(f.Request("outside-lookback", "failed", 503, 0));
        await f.Map.AdminNotifications.InsertOneAsync(legacy);
        await f.SweepAsync(); await f.SweepAsync();
        var row = Assert.Single(await f.Notices());
        Assert.Equal(legacy.Id, row.Id);
        Assert.Equal(legacy.Key, row.Key);
        Assert.Equal("open", row.Status);
        Assert.Equal("unknown", row.IncidentState);
        Assert.Null(row.RecoveredAt);
        Assert.Null(row.HandledAt);
        Assert.Equal(legacy.ActionUrl, row.ActionUrl);
        Assert.Null(row.ExpiresAt);
        Assert.Equal(legacy.CreatedAt, row.CreatedAt);
        Assert.Equal(legacy.UpdatedAt, row.UpdatedAt);
        Assert.Equal(1, row.Title.Split("历史范围待核对").Length - 1);
    }

    private static AdminNotification LegacyRouteNotice(LlmRequestLog log)
    {
        var identity = string.Join("|", log.TenantId.Trim().ToLowerInvariant(),
            log.PlatformId!.Trim().ToLowerInvariant(), log.Model.Trim().ToLowerInvariant(),
            log.RequestType!.Trim().ToLowerInvariant());
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(identity)))
            .ToLowerInvariant()[..24];
        return new AdminNotification { Id = "historical-route", Key = "llmgw-upstream:" + hash,
            Source = "gateway-alert", Section = AdminNotificationSections.Admin, Level = "error",
            Status = "open", ExpiresAt = null, Title = "历史上游故障", Message = "原始旧通知",
            ActionKind = "llm-gateway", ActionUrl = "/logs?requestId=historical-request",
            CreatedAt = RecentStart().AddDays(-5), UpdatedAt = RecentStart().AddDays(-4) };
    }

    private static DateTime RecentStart()
    {
        var value = DateTime.UtcNow.AddMinutes(-4);
        return new DateTime(value.Ticks / TimeSpan.TicksPerMillisecond * TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _name = "prdagent_notification_facts_" + Guid.NewGuid().ToString("N");
        private readonly DateTime _start = RecentStart();
        public MongoDbContext Map { get; }
        public LlmGatewayDataContext Gateway { get; }
        public Fixture()
        {
            var uri = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://localhost:27018";
            _client = new MongoClient(uri);
            Map = new MongoDbContext(uri, _name);
            Gateway = new LlmGatewayDataContext(uri, _name);
        }
        public LlmRequestLog Request(string id, string status, int code, int second)
        {
            var log = GatewayIncidentFactsTests.Request(id, status, code);
            log.StartedAt = _start.AddSeconds(second);
            log.EndedAt = log.StartedAt.AddMilliseconds(10);
            return log;
        }
        public LlmProviderAttempt Attempt(string platform, string status, int code, int order, int second)
        {
            var attempt = GatewayIncidentFactsTests.Attempt(platform, status, code, order);
            attempt.EndedAt = _start.AddSeconds(second).AddMilliseconds(order + 1);
            return attempt;
        }
        public Task Failure(string id, int second)
        {
            var log = Request(id, "failed", 402, second);
            log.Error = "insufficient_balance";
            return Gateway.LlmRequestLogs.InsertOneAsync(log);
        }
        public async Task<LlmRequestLog> Fallback(string id, int second)
        {
            var log = Request(id, "succeeded", 200, second);
            log.PlatformId = "backup";
            log.PlatformName = "backup";
            log.ProviderAttempts = [Attempt("primary", "failed", 402, 0, second), Attempt("backup", "succeeded", 200, 1, second)];
            await Gateway.LlmRequestLogs.InsertOneAsync(log);
            return log;
        }
        public async Task SweepAsync()
        {
            using var watchdog = new LlmGatewayIncidentWatchdog(Gateway, Map, new AdminPushDispatchSignal(),
                new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> {
                    ["LlmGateway:InternalTenantId"] = "fixture-tenant"
                }).Build(), NullLogger<LlmGatewayIncidentWatchdog>.Instance);
            await watchdog.SweepOnceAsync(default);
        }
        public Task<List<AdminNotification>> Notices() => Map.AdminNotifications.Find(_ => true).ToListAsync();
        public ValueTask DisposeAsync() => new(_client.DropDatabaseAsync(_name));
    }
}
