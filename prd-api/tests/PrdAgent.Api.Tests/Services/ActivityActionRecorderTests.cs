using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Filters;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class ActivityActionRecorderTests
{
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ConcurrentDomainRecords_ShouldInsertExactlyOnceAndRedactDisplayMetadata()
    {
        await using var fixture = await ActivityMongoFixture.CreateAsync();
        var recorder = new ActivityActionRecorder(fixture.Db);
        var occurredAt = MongoTime(DateTime.UtcNow);
        var key = HostedSiteEditRunWorker.BuildGeneratedSitePublicationDeduplicationKey("run-once");

        var results = await Task.WhenAll(Enumerable.Range(0, 16).Select(_ =>
            recorder.RecordDomainAsync(
                ActivityActionRegistry.GeneratedSitePublished,
                "user-1",
                "site-1",
                "作品 token=secret-value sk-abcdefghijk",
                key,
                occurredAt,
                CancellationToken.None)));

        Assert.Single(results, inserted => inserted);
        var log = await fixture.Db.ActivityLogs.Find(Builders<ActivityLog>.Filter.Empty).SingleAsync();
        Assert.Equal(ActivityActionRegistry.GeneratedSitePublished, log.Action);
        Assert.Equal("生成并发布了网页", log.ActionLabel);
        Assert.Equal("web-pages", log.Module);
        Assert.Equal("user-1", log.ActorId);
        Assert.Equal("site-1", log.TargetId);
        Assert.Equal("作品 token=*** ***", log.TargetTitle);
        Assert.Equal("DOMAIN", log.Method);
        Assert.Equal(key, log.DeduplicationKey);
        Assert.DoesNotContain("secret-value", log.ToJson(), StringComparison.Ordinal);
        Assert.DoesNotContain("abcdefghijk", log.ToJson(), StringComparison.Ordinal);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task Recovery_ShouldBackfillOnlyCompletedGeneratedSiteAndRemainIdempotent()
    {
        await using var fixture = await ActivityMongoFixture.CreateAsync();
        var completedAt = MongoTime(DateTime.UtcNow.AddMinutes(-1));
        var completed = Run("run-completed", RunStatuses.Done, DesignArtifactOperations.Generate, "site-completed", completedAt);
        var failed = Run("run-failed", RunStatuses.Error, DesignArtifactOperations.Generate, "site-failed", completedAt);
        var edit = Run("run-edit", RunStatuses.Done, DesignArtifactOperations.Edit, "site-edit", completedAt);
        await fixture.Db.DesignArtifactRuns.InsertManyAsync([completed, failed, edit]);
        await fixture.Db.HostedSites.InsertManyAsync([
            Site(completed, "已发布页面"),
            Site(failed, "失败页面"),
            Site(edit, "草稿页面"),
        ]);
        var recorder = new ActivityActionRecorder(fixture.Db);

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db,
            new InMemoryRunQueue(),
            new InMemoryRunEventStore(),
            DateTime.UtcNow,
            CancellationToken.None,
            activityRecorder: recorder);
        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db,
            new InMemoryRunQueue(),
            new InMemoryRunEventStore(),
            DateTime.UtcNow,
            CancellationToken.None,
            activityRecorder: recorder);

        var log = await fixture.Db.ActivityLogs.Find(Builders<ActivityLog>.Filter.Empty).SingleAsync();
        Assert.Equal(completed.Id, log.DeduplicationKey?.Split(':')[1]);
        Assert.Equal(completed.ArtifactSiteId, log.TargetId);
        Assert.Equal(completed.CompletedAt, log.CreatedAt);
        var recoveredRun = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == completed.Id).SingleAsync();
        Assert.NotNull(recoveredRun.PublishedActivityRecordedAt);
        Assert.Equal(0, await HostedSiteEditRunWorker.RecoverGeneratedSitePublicationActivitiesAsync(
            fixture.Db,
            recorder,
            CancellationToken.None));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task Recovery_WhenActivityExistsButMarkerWasNotWritten_ShouldMarkRunAndLeaveNoCandidate()
    {
        await using var fixture = await ActivityMongoFixture.CreateAsync();
        var completedAt = MongoTime(DateTime.UtcNow.AddMinutes(-1));
        var run = Run("run-crash-window", RunStatuses.Done, DesignArtifactOperations.Generate, "site-crash-window", completedAt);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        await fixture.Db.HostedSites.InsertOneAsync(Site(run, "崩溃窗口页面"));
        var recorder = new ActivityActionRecorder(fixture.Db);
        var key = HostedSiteEditRunWorker.BuildGeneratedSitePublicationDeduplicationKey(run.Id);
        Assert.True(await recorder.RecordDomainAsync(
            ActivityActionRegistry.GeneratedSitePublished,
            run.UserId,
            run.ArtifactSiteId!,
            "崩溃窗口页面",
            key,
            completedAt,
            CancellationToken.None));

        Assert.Equal(0, await HostedSiteEditRunWorker.RecoverGeneratedSitePublicationActivitiesAsync(
            fixture.Db,
            recorder,
            CancellationToken.None));

        var recoveredRun = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.NotNull(recoveredRun.PublishedActivityRecordedAt);
        Assert.Equal(0, await HostedSiteEditRunWorker.RecoverGeneratedSitePublicationActivitiesAsync(
            fixture.Db,
            recorder,
            CancellationToken.None));
        Assert.Equal(1, await fixture.Db.ActivityLogs.CountDocumentsAsync(Builders<ActivityLog>.Filter.Empty));
    }

    [Theory]
    [InlineData(RunStatuses.Error, DesignArtifactOperations.Generate, true)]
    [InlineData(RunStatuses.Cancelled, DesignArtifactOperations.Generate, true)]
    [InlineData(RunStatuses.Done, DesignArtifactOperations.Edit, true)]
    [InlineData(RunStatuses.Done, DesignArtifactOperations.Generate, false)]
    [Trait("Category", TestCategories.Integration)]
    public async Task NonPublishedFacts_ShouldNeverCreateSuccessActivity(
        string status,
        string operation,
        bool insertMatchingSite)
    {
        await using var fixture = await ActivityMongoFixture.CreateAsync();
        var run = Run("run-not-published", status, operation, "site-1", MongoTime(DateTime.UtcNow));
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        if (insertMatchingSite)
            await fixture.Db.HostedSites.InsertOneAsync(Site(run, "不应留痕"));
        var recorder = new ActivityActionRecorder(fixture.Db);

        Assert.False(await HostedSiteEditRunWorker.RecordGeneratedSitePublicationAsync(
            fixture.Db,
            recorder,
            run,
            CancellationToken.None));
        Assert.Empty(await fixture.Db.ActivityLogs.Find(Builders<ActivityLog>.Filter.Empty).ToListAsync());
        var unchanged = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Null(unchanged.PublishedActivityRecordedAt);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task StaleDoneObject_WhenAuthoritativeRunFailed_ShouldNotCreateSuccessActivity()
    {
        await using var fixture = await ActivityMongoFixture.CreateAsync();
        var completedAt = MongoTime(DateTime.UtcNow);
        var authoritative = Run(
            "run-authority-check",
            RunStatuses.Error,
            DesignArtifactOperations.Generate,
            "site-authority-check",
            completedAt);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(authoritative);
        await fixture.Db.HostedSites.InsertOneAsync(Site(authoritative, "权威状态失败页面"));
        var stale = Run(
            authoritative.Id,
            RunStatuses.Done,
            authoritative.Operation,
            authoritative.ArtifactSiteId!,
            completedAt);
        var recorder = new ActivityActionRecorder(fixture.Db);

        Assert.False(await HostedSiteEditRunWorker.RecordGeneratedSitePublicationAsync(
            fixture.Db,
            recorder,
            stale,
            CancellationToken.None));
        Assert.Equal(0, await fixture.Db.ActivityLogs.CountDocumentsAsync(Builders<ActivityLog>.Filter.Empty));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ExistingDeduplicationKey_WithDifferentFact_ShouldFailClosed()
    {
        await using var fixture = await ActivityMongoFixture.CreateAsync();
        var recorder = new ActivityActionRecorder(fixture.Db);
        const string key = "design-artifact:collision:site-published";
        await recorder.RecordDomainAsync(
            ActivityActionRegistry.GeneratedSitePublished,
            "user-1",
            "site-1",
            "站点一",
            key,
            DateTime.UtcNow,
            CancellationToken.None);

        await Assert.ThrowsAsync<InvalidOperationException>(() => recorder.RecordDomainAsync(
            ActivityActionRegistry.GeneratedSitePublished,
            "user-1",
            "site-2",
            "站点二",
            key,
            DateTime.UtcNow,
            CancellationToken.None));
        Assert.Equal(1, await fixture.Db.ActivityLogs.CountDocumentsAsync(Builders<ActivityLog>.Filter.Empty));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task Recovery_ShouldTerminalizeOneHundredBadCandidatesAndReachOlderValidRun()
    {
        await using var fixture = await ActivityMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var invalid = Enumerable.Range(0, 100)
            .Select(index => Run($"invalid-{index:D3}", RunStatuses.Done, DesignArtifactOperations.Generate, $"missing-{index:D3}", now.AddSeconds(-index)))
            .ToList();
        var valid = Run("older-valid", RunStatuses.Done, DesignArtifactOperations.Generate, "site-valid", now.AddMinutes(-10));
        await fixture.Db.DesignArtifactRuns.InsertManyAsync(invalid.Append(valid));
        await fixture.Db.HostedSites.InsertOneAsync(Site(valid, "有效页面"));

        var inserted = await HostedSiteEditRunWorker.RecoverGeneratedSitePublicationActivitiesAsync(
            fixture.Db,
            new ActivityActionRecorder(fixture.Db),
            CancellationToken.None);

        Assert.Equal(1, inserted);
        Assert.Equal(1, await fixture.Db.ActivityLogs.CountDocumentsAsync(Builders<ActivityLog>.Filter.Empty));
        Assert.Equal(100, await fixture.Db.DesignArtifactRuns.CountDocumentsAsync(item =>
            item.PublishedActivityProjectionOutcome == "skipped"));
        Assert.Equal(0, await HostedSiteEditRunWorker.RecoverGeneratedSitePublicationActivitiesAsync(
            fixture.Db,
            new ActivityActionRecorder(fixture.Db),
            CancellationToken.None));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task TransientRecorderFailure_ShouldLeaveProjectionPendingForRetry()
    {
        await using var fixture = await ActivityMongoFixture.CreateAsync();
        var run = Run("retryable", RunStatuses.Done, DesignArtifactOperations.Generate, "site-retryable", MongoTime(DateTime.UtcNow));
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        await fixture.Db.HostedSites.InsertOneAsync(Site(run, "稍后重试页面"));

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            HostedSiteEditRunWorker.RecordGeneratedSitePublicationAsync(
                fixture.Db,
                new AlwaysFailingRecorder(),
                run,
                CancellationToken.None));
        var pending = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Null(pending.PublishedActivityProjectionCompletedAt);

        Assert.True(await HostedSiteEditRunWorker.RecordGeneratedSitePublicationAsync(
            fixture.Db,
            new ActivityActionRecorder(fixture.Db),
            pending,
            CancellationToken.None));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task Recovery_TransientHeadFailure_ShouldNotStarveOlderCandidateAndShouldRetryLater()
    {
        await using var fixture = await ActivityMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var failing = Run("newer-transient", RunStatuses.Done, DesignArtifactOperations.Generate, "site-transient", now);
        var valid = Run("older-after-transient", RunStatuses.Done, DesignArtifactOperations.Generate, "site-after-transient", now.AddMinutes(-1));
        await fixture.Db.DesignArtifactRuns.InsertManyAsync([failing, valid]);
        await fixture.Db.HostedSites.InsertManyAsync([Site(failing, "暂时失败"), Site(valid, "仍需处理")]);
        var real = new ActivityActionRecorder(fixture.Db);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            HostedSiteEditRunWorker.RecoverGeneratedSitePublicationActivitiesAsync(
                fixture.Db,
                new FailingForTargetRecorder(real, failing.ArtifactSiteId!),
                CancellationToken.None));
        Assert.Equal(1, await fixture.Db.ActivityLogs.CountDocumentsAsync(item => item.TargetId == valid.ArtifactSiteId));
        var stillPending = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == failing.Id).SingleAsync();
        Assert.Null(stillPending.PublishedActivityProjectionCompletedAt);

        Assert.Equal(1, await HostedSiteEditRunWorker.RecoverGeneratedSitePublicationActivitiesAsync(
            fixture.Db,
            real,
            CancellationToken.None));
        Assert.Equal(0, await HostedSiteEditRunWorker.RecoverGeneratedSitePublicationActivitiesAsync(
            fixture.Db,
            real,
            CancellationToken.None));
    }

    [Fact]
    public void HttpActivityWithoutDeduplicationKey_ShouldOmitSparseIndexedField()
    {
        var document = new ActivityLog { ActorId = "user-1" }.ToBsonDocument();
        Assert.False(document.Contains(nameof(ActivityLog.DeduplicationKey)));
    }

    [Fact]
    public void MongoIndexCatalog_ShouldDeclareSparseUniqueDomainDeduplicationIndex()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "scripts", "mongodb-indexes.js")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var catalog = File.ReadAllText(Path.Combine(directory!.FullName, "scripts", "mongodb-indexes.js"));
        Assert.Contains("uniq_activity_logs_deduplication_key", catalog, StringComparison.Ordinal);
        Assert.Contains("{ name: \"uniq_activity_logs_deduplication_key\", unique: true, sparse: true }", catalog, StringComparison.Ordinal);
        Assert.Contains("idx_design_artifact_runs_publication_audit_pending", catalog, StringComparison.Ordinal);
        Assert.Contains("\"PublishedActivityProjectionCompletedAt\": null", catalog, StringComparison.Ordinal);
        Assert.Contains("\"Status\": \"Done\"", catalog, StringComparison.Ordinal);
    }

    [Fact]
    public void CdsCompose_ShouldGateApiCutoverOnVerifiedMongoIndexCatalog()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "cds-compose.yml")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var compose = File.ReadAllText(Path.Combine(directory!.FullName, "cds-compose.yml"));
        Assert.Contains("mongodb-indexes: { condition: service_completed_successfully }", compose, StringComparison.Ordinal);
        Assert.Contains("load(\"/repo/scripts/mongodb-indexes.js\")", compose, StringComparison.Ordinal);
        Assert.Contains("restart: \"no\"", compose, StringComparison.Ordinal);
    }

    private static DesignArtifactRun Run(
        string id,
        string status,
        string operation,
        string siteId,
        DateTime completedAt) => new()
    {
        Id = id,
        UserId = "user-1",
        Status = status,
        ArtifactType = DesignArtifactTypes.WebPage,
        Operation = operation,
        ArtifactSiteId = siteId,
        Title = "测试页面",
        Instruction = "生成页面",
        CompletedAt = completedAt,
        CreatedAt = completedAt.AddMinutes(-1),
        UpdatedAt = completedAt,
    };

    private static HostedSite Site(DesignArtifactRun run, string title) => new()
    {
        Id = run.ArtifactSiteId!,
        OwnerUserId = run.UserId,
        SourceType = "design-agent",
        SourceRef = run.Id,
        Title = title,
        CreatedAt = run.CompletedAt ?? DateTime.UtcNow,
        UpdatedAt = run.CompletedAt ?? DateTime.UtcNow,
        ContentVersion = run.CompletedAt ?? DateTime.UtcNow,
    };

    private static DateTime MongoTime(DateTime value) =>
        new(value.Ticks - value.Ticks % TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);

    private sealed class ActivityMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private ActivityMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<ActivityMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            var fixture = new ActivityMongoFixture(
                client,
                connectionString,
                $"activity_action_recorder_{Guid.NewGuid():N}");
            await fixture.Db.ActivityLogs.Indexes.CreateOneAsync(new CreateIndexModel<ActivityLog>(
                Builders<ActivityLog>.IndexKeys.Ascending(item => item.DeduplicationKey),
                new CreateIndexOptions { Name = "uniq_activity_logs_deduplication_key", Unique = true, Sparse = true }));
            await fixture.Db.DesignArtifactRuns.Indexes.CreateOneAsync(new CreateIndexModel<DesignArtifactRun>(
                Builders<DesignArtifactRun>.IndexKeys.Descending(item => item.CompletedAt),
                new CreateIndexOptions<DesignArtifactRun>
                {
                    Name = "idx_design_artifact_runs_publication_audit_pending",
                    PartialFilterExpression = new BsonDocument
                    {
                        [nameof(DesignArtifactRun.Status)] = RunStatuses.Done,
                        [nameof(DesignArtifactRun.ArtifactType)] = DesignArtifactTypes.WebPage,
                        [nameof(DesignArtifactRun.Operation)] = DesignArtifactOperations.Generate,
                        [nameof(DesignArtifactRun.ArtifactSiteId)] = new BsonDocument("$type", "string"),
                        [nameof(DesignArtifactRun.CompletedAt)] = new BsonDocument("$type", "date"),
                        [nameof(DesignArtifactRun.PublishedActivityProjectionCompletedAt)] = BsonNull.Value,
                    },
                }));
            return fixture;
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }

    private sealed class AlwaysFailingRecorder : IActivityActionRecorder
    {
        public Task<bool> RecordHttpAsync(ActivityActionDef definition, string action, string actorId, string? targetId, string? targetTitle, string method, string path, CancellationToken ct = default) =>
            throw new InvalidOperationException("transient");

        public Task<bool> RecordDomainAsync(string action, string actorId, string targetId, string? targetTitle, string deduplicationKey, DateTime occurredAt, CancellationToken ct = default) =>
            throw new InvalidOperationException("transient");
    }

    private sealed class FailingForTargetRecorder : IActivityActionRecorder
    {
        private readonly IActivityActionRecorder _inner;
        private readonly string _targetId;

        public FailingForTargetRecorder(IActivityActionRecorder inner, string targetId)
        {
            _inner = inner;
            _targetId = targetId;
        }

        public Task<bool> RecordHttpAsync(ActivityActionDef definition, string action, string actorId, string? targetId, string? targetTitle, string method, string path, CancellationToken ct = default) =>
            _inner.RecordHttpAsync(definition, action, actorId, targetId, targetTitle, method, path, ct);

        public Task<bool> RecordDomainAsync(string action, string actorId, string targetId, string? targetTitle, string deduplicationKey, DateTime occurredAt, CancellationToken ct = default) =>
            targetId == _targetId
                ? throw new InvalidOperationException("transient")
                : _inner.RecordDomainAsync(action, actorId, targetId, targetTitle, deduplicationKey, occurredAt, ct);
    }
}
