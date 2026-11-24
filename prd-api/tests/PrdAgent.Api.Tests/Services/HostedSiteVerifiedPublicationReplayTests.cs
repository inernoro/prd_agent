using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", TestCategories.Integration)]
public sealed class HostedSiteVerifiedPublicationReplayTests
{
    [Fact]
    public async Task Recovery_WithCompletedUploadIntentButNoCleanupStarted_ShouldPreserveAndReplaySite()
    {
        await using var fixture = await Fixture.CreateAsync();
        var site = await fixture.PublishAsync("worker-a");
        var now = DateTime.UtcNow;
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(x => x.Id == fixture.Run.Id,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.Runtime, DesignArtifactRuntimes.OpenDesign)
                .Set(x => x.ContractVersion, DesignArtifactContractVersions.Current)
                .Set(x => x.LifecycleVersion, 2)
                .Set(x => x.LeaseExpiresAt, now.AddMinutes(-2))
                .Set(x => x.WorkspaceResultAssetKey, "trusted/result-ready.json")
                .Set(x => x.WorkspaceRef, new DesignArtifactWorkspaceRef
                {
                    WorkspaceId = "workspace-replay",
                    Kind = DesignArtifactWorkspaceKinds.RemotePackage,
                    BaseRevision = "base-revision",
                    Adapter = WebPageDesignArtifactLifecycleAdapter.AdapterId,
                })
                .Set(x => x.VersionBoundary, new DesignArtifactVersionBoundary { BaseContentHash = new string('a', 64) }));
        var events = new InMemoryRunEventStore();
        var queue = new InMemoryRunQueue();
        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db, queue, events, now, CancellationToken.None,
            fixture.CreateService(), lifecycle: new DesignArtifactLifecycleService(fixture.Db, events));

        var resumed = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == fixture.Run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Queued, resumed.Status);
        Assert.True(resumed.CleanupPending);
        Assert.Null(resumed.CleanupStartedAt);
        Assert.True(await fixture.Db.HostedSites.Find(x => x.Id == site.Id).AnyAsync());
        Assert.Equal(6, fixture.Objects.Count);
        Assert.Equal(6, fixture.Uploads);
        await fixture.TransferLeaseAsync();
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(x => x.Id == fixture.Run.Id,
            Builders<DesignArtifactRun>.Update.Set(x => x.Status, RunStatuses.Committing));
        var replayed = await fixture.PublishAsync("worker-b");
        Assert.Equal(site.Id, replayed.Id);
        Assert.Equal(6, fixture.Uploads);
        Assert.Equal(site.Files.Select(x => x.CosKey), replayed.Files.Select(x => x.CosKey));
    }

    [Fact]
    public async Task CrashAfterSiteInsertBeforeProducedWrite_ShouldClaimSameSiteAfterLeaseTransfer()
    {
        await using var fixture = await Fixture.CreateAsync();
        var first = await fixture.PublishAsync("worker-a");
        var interrupted = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == fixture.Run.Id).SingleAsync();
        Assert.Null(interrupted.ProducedArtifactSiteId);
        Assert.Null(interrupted.ProducedArtifactRevisionId);
        await fixture.TransferLeaseAsync();

        // 重建服务模拟进程重启，数据库与对象存储是唯一可恢复状态。
        var recovered = await fixture.PublishAsync("worker-b");

        Assert.Equal(first.Id, recovered.Id);
        Assert.Equal(first.Files.Select(x => x.CosKey), recovered.Files.Select(x => x.CosKey));
        Assert.Equal(1, await fixture.Db.HostedSites.CountDocumentsAsync(FilterDefinition<HostedSite>.Empty));
        Assert.Equal(6, fixture.Uploads);
        Assert.Equal(6, fixture.Objects.Count);
        var resumed = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == fixture.Run.Id).SingleAsync();
        Assert.Equal(first.Id, resumed.CleanupArtifactSiteId);
        Assert.Equal(interrupted.CleanupPublishAttemptId, resumed.CleanupPublishAttemptId);
        Assert.Equal(interrupted.CleanupAssetKeys, resumed.CleanupAssetKeys);
    }

    [Fact]
    public async Task Replay_WhenStoredOwnerDiffers_ShouldRejectWithoutUploadingOrClaiming()
    {
        await using var fixture = await Fixture.CreateAsync();
        var site = await fixture.PublishAsync("worker-a");
        await fixture.Db.HostedSites.UpdateOneAsync(x => x.Id == site.Id,
            Builders<HostedSite>.Update.Set(x => x.OwnerUserId, "another-user"));
        await fixture.TransferLeaseAsync();

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.PublishAsync("worker-b"));

        Assert.Contains("其他来源", error.Message, StringComparison.Ordinal);
        Assert.Equal(6, fixture.Uploads);
        Assert.Null((await fixture.Db.DesignArtifactRuns.Find(x => x.Id == fixture.Run.Id).SingleAsync()).ProducedArtifactSiteId);
    }

    [Fact]
    public async Task Replay_WhenObjectBytesDifferAtEqualLength_ShouldRejectWithoutOverwriting()
    {
        await using var fixture = await Fixture.CreateAsync();
        var site = await fixture.PublishAsync("worker-a");
        var key = site.Files.Single(x => x.Path == "assets/design-tokens.json").CosKey;
        fixture.Objects[key] = Encoding.UTF8.GetBytes("[]");
        await fixture.TransferLeaseAsync();

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.PublishAsync("worker-b"));

        Assert.Contains("对象内容不一致", error.Message, StringComparison.Ordinal);
        Assert.Equal("[]", Encoding.UTF8.GetString(fixture.Objects[key]));
        Assert.Equal(6, fixture.Uploads);
    }

    [Fact]
    public async Task Replay_WithOldLease_ShouldRejectAlreadyStoredSite()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.PublishAsync("worker-a");
        await fixture.TransferLeaseAsync();

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.PublishAsync("worker-a"));

        Assert.Contains("租约或补偿账本已变化", error.Message, StringComparison.Ordinal);
        Assert.Equal(6, fixture.Uploads);
    }

    [Fact]
    public async Task OldWorkerCompensation_AfterLeaseTransferAndReplay_ShouldNotDeleteClaimedSite()
    {
        await using var fixture = await Fixture.CreateAsync();
        var site = await fixture.PublishAsync("worker-a");
        await fixture.TransferLeaseAsync();
        await fixture.PublishAsync("worker-b");

        Assert.False(await fixture.CreateService().CompensateGeneratedSiteWithLeaseAsync(
            site.Id, fixture.Run.Id, fixture.Run.UserId, "worker-a", CancellationToken.None));

        Assert.True(await fixture.Db.HostedSites.Find(x => x.Id == site.Id).AnyAsync());
        Assert.Equal(6, fixture.Objects.Count);
        var run = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == fixture.Run.Id).SingleAsync();
        Assert.True(run.CleanupPending);
        Assert.Null(run.CleanupLeaseOwnerId);
    }

    [Fact]
    public async Task Compensation_WhenSiteReferencesAnotherAttempt_ShouldPreserveItsObjects()
    {
        await using var fixture = await Fixture.CreateAsync();
        var site = await fixture.PublishAsync("worker-a");
        site.Files[0].CosKey = "web-hosting/sites/new-attempt/asset.json";
        await fixture.Db.HostedSites.UpdateOneAsync(x => x.Id == site.Id,
            Builders<HostedSite>.Update.Set(x => x.Files, site.Files));

        Assert.False(await fixture.CreateService().CompensateGeneratedSiteWithLeaseAsync(
            site.Id, fixture.Run.Id, fixture.Run.UserId, "worker-a", CancellationToken.None));

        Assert.True(await fixture.Db.HostedSites.Find(x => x.Id == site.Id).AnyAsync());
        Assert.Equal(6, fixture.Objects.Count);
    }

    [Fact]
    public async Task RetryWithIncompleteUploadPlan_ShouldNotOverwriteCompensationLedger()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(x => x.Id == fixture.Run.Id,
            Builders<DesignArtifactRun>.Update.Set(x => x.CleanupPending, true)
                .Set(x => x.CleanupArtifactSiteId, "previous-site")
                .Set(x => x.CleanupPublishAttemptId, "previous-attempt")
                .Set(x => x.CleanupAssetKeys, new List<string> { "previous-object" }));

        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.PublishAsync("worker-a"));

        var stored = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == fixture.Run.Id).SingleAsync();
        Assert.Equal("previous-site", stored.CleanupArtifactSiteId);
        Assert.Equal("previous-attempt", stored.CleanupPublishAttemptId);
        Assert.Equal(new[] { "previous-object" }, stored.CleanupAssetKeys);
        Assert.Equal(0, fixture.Uploads);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _database;
        private readonly Mock<IAssetStorage> _storage = new(MockBehavior.Strict);
        internal MongoDbContext Db { get; }
        internal DesignArtifactRun Run { get; } = new()
        {
            Id = "run-replayed-publish", UserId = "replay-owner", Status = RunStatuses.Committing,
            LeaseOwnerId = "worker-a", LeaseExpiresAt = DateTime.UtcNow.AddMinutes(5),
            Operation = DesignArtifactOperations.Generate,
        };
        internal Dictionary<string, byte[]> Objects { get; } = new(StringComparer.Ordinal);
        internal int Uploads { get; private set; }

        private Fixture(MongoClient client, string connection, string database)
        {
            _client = client;
            _database = database;
            Db = new MongoDbContext(connection, database);
            _storage.Setup(x => x.BuildSiteKey(It.IsAny<string>(), It.IsAny<string>()))
                .Returns((string site, string path) => $"web-hosting/sites/{site}/{path}");
            _storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>()))
                .Returns((string key) => $"https://assets.test/{key}");
            _storage.Setup(x => x.UploadToKeyAsync(It.IsAny<string>(), It.IsAny<byte[]>(),
                    It.IsAny<string?>(), It.IsAny<CancellationToken>(), It.IsAny<string?>()))
                .Callback((string key, byte[] bytes, string? _, CancellationToken _, string? _) =>
                {
                    Uploads++;
                    Objects[key] = bytes.ToArray();
                }).Returns(Task.CompletedTask);
            _storage.Setup(x => x.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .ReturnsAsync((string key, CancellationToken _) => Objects.GetValueOrDefault(key));
        }

        internal static async Task<Fixture> CreateAsync()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connection);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            var fixture = new Fixture(client, connection, $"verified_publication_replay_{Guid.NewGuid():N}");
            await fixture.Db.DesignArtifactRuns.InsertOneAsync(fixture.Run);
            return fixture;
        }

        internal Task TransferLeaseAsync() => Db.DesignArtifactRuns.UpdateOneAsync(x => x.Id == Run.Id,
            Builders<DesignArtifactRun>.Update.Set(x => x.LeaseOwnerId, "worker-b")
                .Set(x => x.LeaseExpiresAt, DateTime.UtcNow.AddMinutes(5)));

        internal Task<HostedSite> PublishAsync(string lease)
        {
            var service = CreateService();
            var paths = new[] { "assets/accessibility-static-report.json", "assets/design-tokens.json",
                "assets/page-outline.json", "assets/provenance.json", "index.html", "manifest.json" };
            var files = paths.Select(path =>
            {
                var bytes = Encoding.UTF8.GetBytes(path == "index.html"
                    ? HostedSiteRevisionRules.HardenGeneratedHtml("<!doctype html><html><head><title>恢复</title></head><body><main>恢复</main></body></html>")
                    : "{}");
                return new HostedSiteVerifiedFile(path, bytes, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
                    path == "index.html" ? "text/html; charset=utf-8" : "application/json; charset=utf-8");
            }).ToArray();
            return service.CreateFromVerifiedFilesAsync(Run.UserId, files, "断点恢复", null,
                "design-agent", Run.Id, null, null, lease, CancellationToken.None);
        }

        internal HostedSiteService CreateService() => new(Db, _storage.Object, Mock.Of<IShortLinkService>(),
            Mock.Of<ISharePasswordService>(), Mock.Of<ITeamService>(), Mock.Of<ITeamActivityService>(),
            Mock.Of<IUploadProgressService>(), Mock.Of<IAskOpeningQuestionGenerator>(),
            NullLogger<HostedSiteService>.Instance);

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_database);
    }
}
