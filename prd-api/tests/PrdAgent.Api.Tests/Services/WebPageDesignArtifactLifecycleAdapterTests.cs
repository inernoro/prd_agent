using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class WebPageDesignArtifactLifecycleAdapterTests
{
    [Fact]
    public void InitializeNewRun_ShouldFreezeRemoteCapabilityAndCreateAuthoritativeEvent()
    {
        var run = NewRun(DesignArtifactOperations.Generate);

        WebPageDesignArtifactLifecycleAdapter.InitializeNewRun(run, Capability(), currentHtml: null);

        Assert.Equal(DesignArtifactContractVersions.Current, run.ContractVersion);
        Assert.Equal(RunStatuses.Queued, run.Status);
        Assert.Equal(1, run.LifecycleVersion);
        Assert.Equal(1, run.LifecycleEventSequence);
        Assert.Equal(DesignArtifactWorkspaceKinds.RemotePackage, run.WorkspaceRef?.Kind);
        Assert.Equal(WebPageDesignArtifactLifecycleAdapter.AdapterId, run.WorkspaceRef?.Adapter);
        Assert.Equal(DesignArtifactSecurityProfiles.WebPageRestricted, run.Capability?.SecurityProfile);
        var created = Assert.Single(run.LifecycleEvents);
        Assert.True(created.Authoritative);
        Assert.Equal(DesignArtifactLifecycleEventTypes.Run, created.Type);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task StartAsync_ConcurrentClaims_ShouldHaveOneWinnerAndAtomicEventLeaseState()
    {
        await using var fixture = await Fixture.CreateAsync();
        var run = NewRun(DesignArtifactOperations.Generate);
        WebPageDesignArtifactLifecycleAdapter.InitializeNewRun(run, Capability(), null);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var expected = Expected(run);

        var attempts = await Task.WhenAll(
            TryStartAsync(service, run, expected, "worker-a"),
            TryStartAsync(service, run, expected, "worker-b"));

        Assert.Single(attempts, result => result.Run != null);
        Assert.Single(attempts, result => result.Error?.Code == DesignArtifactLifecycleErrorCodes.Conflict);
        var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Running, persisted.Status);
        Assert.Contains(persisted.LeaseOwnerId, new[] { "worker-a", "worker-b" });
        Assert.NotNull(persisted.LeaseExpiresAt);
        Assert.Equal(2, persisted.LifecycleVersion);
        Assert.Equal(2, persisted.LifecycleEventSequence);
        Assert.Equal(
            [DesignArtifactLifecycleEventTypes.Run, DesignArtifactLifecycleEventTypes.Phase],
            persisted.LifecycleEvents.Select(item => item.Type));
        Assert.True(persisted.LifecycleEvents[^1].Authoritative);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task CommitAndComplete_ShouldUseBrokerFactsAndPublicFilesOnly()
    {
        await using var fixture = await Fixture.CreateAsync();
        var setup = await StartedAdapterAsync(fixture, DesignArtifactOperations.Generate);
        var files = Files();
        await StoreBrokerFactsAsync(fixture.Db, setup.Run.Id);

        await setup.Adapter.CommitManifestAsync(setup.Run.Id, files, ActiveLease(setup.Run));
        await setup.Adapter.CompleteAsync(setup.Run.Id, ActiveLease(setup.Run));

        var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == setup.Run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Done, persisted.Status);
        Assert.Equal(2, persisted.Manifest?.Files.Count);
        Assert.DoesNotContain(
            persisted.Manifest!.Files,
            file => file.Path == DesignArtifactPublicRevision.InternalManifestPath);
        Assert.Equal(new string('a', 64), persisted.ManifestValidation?.SourcePackageHash);
        Assert.Equal(new string('b', 64), persisted.ManifestValidation?.SourceManifestHash);
        Assert.Equal(
            DesignArtifactPublicRevision.Compute(persisted.Manifest.Files.Select(file =>
                new DesignArtifactPublicRevisionFile(file.Path, file.Sha256, file.ByteLength, file.MediaType))),
            persisted.VersionBoundary?.PackageHash);
        Assert.Equal(
            [
                DesignArtifactLifecycleEventTypes.Run,
                DesignArtifactLifecycleEventTypes.Phase,
                DesignArtifactLifecycleEventTypes.Manifest,
                DesignArtifactLifecycleEventTypes.Done,
            ],
            persisted.LifecycleEvents.Where(item => item.Authoritative).Select(item => item.Type));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task InterruptedRunWithoutResult_ShouldFailThroughAuthoritativeLifecycle()
    {
        await using var fixture = await Fixture.CreateAsync();
        var setup = await StartedAdapterAsync(fixture, DesignArtifactOperations.Generate);
        var expiredAt = DateTime.UtcNow.AddMinutes(-1);
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            run => run.Id == setup.Run.Id,
            Builders<DesignArtifactRun>.Update.Set(run => run.LeaseExpiresAt, expiredAt));

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db,
            Mock.Of<IRunQueue>(),
            new InMemoryRunEventStore(),
            DateTime.UtcNow,
            CancellationToken.None,
            publicLifecycle: setup.Adapter);

        var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == setup.Run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Error, persisted.Status);
        Assert.Equal(WebPageDesignArtifactLifecycleAdapter.InterruptedFailureCode, persisted.LifecycleFailureCode);
        Assert.Equal(DesignArtifactLifecycleEventTypes.Error, persisted.LifecycleEvents[^1].Type);
        Assert.True(persisted.LifecycleEvents[^1].Authoritative);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PhaseMutation_ShouldBeAtomicAndRejectLostLease()
    {
        await using var fixture = await Fixture.CreateAsync();
        var setup = await StartedAdapterAsync(fixture, DesignArtifactOperations.Generate);

        await setup.Adapter.AppendPhaseAsync(
            setup.Run.Id,
            ActiveLease(setup.Run),
            37,
            "正在生成公开文件");

        var updated = await fixture.Db.DesignArtifactRuns.Find(run => run.Id == setup.Run.Id).SingleAsync();
        Assert.Equal(37, updated.Progress);
        Assert.Equal("正在生成公开文件", updated.Phase);
        Assert.Equal(3, updated.LifecycleEventSequence);
        Assert.Equal("正在生成公开文件", updated.LifecycleEvents[^1].Phase);
        Assert.False(updated.LifecycleEvents[^1].Authoritative);

        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            run => run.Id == setup.Run.Id,
            Builders<DesignArtifactRun>.Update
                .Set(run => run.LeaseOwnerId, "worker-new")
                .Set(run => run.LeaseExpiresAt, DateTime.UtcNow.AddMinutes(2)));
        await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() =>
            setup.Adapter.AppendPhaseAsync(
                setup.Run.Id,
                ActiveLease(setup.Run),
                50,
                "旧 worker 不应写入"));
        var afterLostLease = await fixture.Db.DesignArtifactRuns.Find(run => run.Id == setup.Run.Id).SingleAsync();
        Assert.Equal(37, afterLostLease.Progress);
        Assert.Equal(3, afterLostLease.LifecycleEventSequence);
        Assert.DoesNotContain(afterLostLease.LifecycleEvents, item => item.Phase == "旧 worker 不应写入");
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task FailMutation_ShouldRejectLostLeaseWithoutChangingAuthority()
    {
        await using var fixture = await Fixture.CreateAsync();
        var setup = await StartedAdapterAsync(fixture, DesignArtifactOperations.Generate);
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            run => run.Id == setup.Run.Id,
            Builders<DesignArtifactRun>.Update
                .Set(run => run.LeaseOwnerId, "worker-new")
                .Set(run => run.LeaseExpiresAt, DateTime.UtcNow.AddMinutes(2)));

        await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() =>
            setup.Adapter.FailAsync(
                setup.Run.Id,
                WebPageDesignArtifactLifecycleAdapter.ExecutionFailureCode,
                ActiveLease(setup.Run)));

        var persisted = await fixture.Db.DesignArtifactRuns.Find(run => run.Id == setup.Run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Running, persisted.Status);
        Assert.Null(persisted.LifecycleFailureCode);
        Assert.DoesNotContain(persisted.LifecycleEvents, item => item.Type == DesignArtifactLifecycleEventTypes.Error);
    }

    [Theory]
    [InlineData(DesignArtifactOperations.Generate)]
    [InlineData(DesignArtifactOperations.Edit)]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishedRevisionRecovery_ShouldBindGenerateAndEdit(string operation)
    {
        await using var fixture = await Fixture.CreateAsync();
        var setup = await StartedAdapterAsync(fixture, operation);
        var files = Files();
        await StoreBrokerFactsAsync(fixture.Db, setup.Run.Id);
        await setup.Adapter.CommitManifestAsync(setup.Run.Id, files, ActiveLease(setup.Run));
        await setup.Adapter.CompleteAsync(setup.Run.Id, ActiveLease(setup.Run));
        var siteId = operation == DesignArtifactOperations.Edit ? "site-edit" : "site-generate";
        var revisionId = $"revision-{operation}";
        await fixture.Db.HostedSites.InsertOneAsync(new HostedSite
        {
            Id = siteId,
            OwnerUserId = setup.Run.UserId,
            ContentVersion = DateTime.UtcNow,
        });
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(new HostedSiteRevision
        {
            Id = revisionId,
            SiteId = siteId,
            CreatedByUserId = setup.Run.UserId,
            Status = HostedSiteRevisionStatuses.Published,
            SourceRunId = setup.Run.Id,
            Runtime = DesignArtifactRuntimes.OpenDesign,
            Html = Html,
            VerifiedFiles = files.Select(ToRevisionFile).ToList(),
            BasedOnContentVersion = DateTime.UtcNow,
            PublishedContentVersion = DateTime.UtcNow,
            PublishedAt = DateTime.UtcNow,
        });
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(new HostedSiteRevision
        {
            Id = $"legacy-{revisionId}",
            SiteId = "legacy-site",
            CreatedByUserId = setup.Run.UserId,
            Status = HostedSiteRevisionStatuses.Published,
            SourceRunId = "legacy-run-without-v2-contract",
            Runtime = DesignArtifactRuntimes.OpenDesign,
            Html = Html,
            BasedOnContentVersion = DateTime.UtcNow,
            PublishedContentVersion = DateTime.UtcNow,
            PublishedAt = DateTime.UtcNow.AddMinutes(1),
        });

        var recovered = await setup.Adapter.RecoverPendingAsync(limit: 1);

        Assert.Equal(1, recovered);
        var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == setup.Run.Id).SingleAsync();
        Assert.Equal(siteId, persisted.ArtifactSiteId);
        Assert.Equal(revisionId, persisted.ArtifactRevisionId);
        Assert.Equal(DesignArtifactLifecycleEventTypes.Published, persisted.LifecycleEvents[^1].Type);
        Assert.True(persisted.LifecycleEvents[^1].Authoritative);
    }

    private const string Html = "<!doctype html><html><body><h1>可信页面</h1></body></html>";

    private static async Task<(DesignArtifactRun Run, WebPageDesignArtifactLifecycleAdapter Adapter)> StartedAdapterAsync(
        Fixture fixture,
        string operation)
    {
        var run = NewRun(operation);
        WebPageDesignArtifactLifecycleAdapter.InitializeNewRun(
            run,
            Capability(),
            operation == DesignArtifactOperations.Edit ? Html : null);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var lifecycle = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        run = await lifecycle.StartAsync(new StartDesignArtifactSessionRequest(
            run.Id,
            run.UserId,
            Expected(run),
            "worker-test",
            DateTime.UtcNow.AddMinutes(2)));
        return (
            run,
            new WebPageDesignArtifactLifecycleAdapter(
                fixture.Db,
                lifecycle,
                Mock.Of<IDesignArtifactWorkspaceBroker>(),
                Microsoft.Extensions.Logging.Abstractions.NullLogger<WebPageDesignArtifactLifecycleAdapter>.Instance));
    }

    private static async Task StoreBrokerFactsAsync(MongoDbContext db, string runId)
    {
        await db.DesignArtifactRuns.UpdateOneAsync(
            run => run.Id == runId,
            Builders<DesignArtifactRun>.Update
                .Set(run => run.WorkspaceResultAssetKey, "web-hosting/meta/result.json")
                .Set(run => run.WorkspaceResultSha256, new string('a', 64))
                .Set(run => run.WorkspaceManifestSha256, new string('b', 64)));
    }

    private static IReadOnlyList<DesignWorkspaceFile> Files()
    {
        var html = Encoding.UTF8.GetBytes(Html);
        var css = Encoding.UTF8.GetBytes("body{color:#111}");
        var manifest = Encoding.UTF8.GetBytes("{\"schemaVersion\":\"test\"}");
        return
        [
            File("index.html", html, "text/html"),
            File("assets/theme.css", css, "text/css"),
            File(DesignArtifactPublicRevision.InternalManifestPath, manifest, "application/json"),
        ];
    }

    private static DesignWorkspaceFile File(string path, byte[] content, string mediaType) => new(
        path,
        Convert.ToBase64String(content),
        Sha256Hex(content),
        content.LongLength,
        mediaType);

    private static HostedSiteRevisionFile ToRevisionFile(DesignWorkspaceFile file) => new()
    {
        Path = file.Path,
        Content = Convert.FromBase64String(file.ContentBase64),
        Sha256 = file.Sha256,
        MimeType = file.MediaType,
    };

    private static DesignArtifactRun NewRun(string operation) => new()
    {
        Id = Guid.NewGuid().ToString("N"),
        UserId = "owner-user",
        Status = RunStatuses.Queued,
        ArtifactType = DesignArtifactTypes.WebPage,
        Operation = operation,
        SourceSurface = DesignArtifactSourceSurfaces.WebHosting,
        Runtime = DesignArtifactRuntimes.OpenDesign,
        TargetSiteId = operation == DesignArtifactOperations.Edit ? "site-edit" : null,
        Instruction = operation == DesignArtifactOperations.Edit ? "调整页面层级" : "生成产品介绍页",
        Title = "网页",
        UserSuppliedContentHash = new string('c', 64),
        Progress = 2,
        Phase = "任务已进入队列",
    };

    private static DesignArtifactProviderCapability Capability() => new(
        DesignArtifactRuntimes.OpenDesign,
        "OpenDesign",
        DesignArtifactAdapterKinds.RemoteAgent,
        DesignArtifactExecutionOwners.CdsRemoteAgent,
        DesignArtifactIsolationModes.SessionContainer,
        [DesignArtifactTypes.WebPage],
        [DesignArtifactOperations.Generate, DesignArtifactOperations.Edit],
        [DesignArtifactSourceSurfaces.WebHosting, DesignArtifactSourceSurfaces.KnowledgeBase],
        Configured: true,
        Healthy: true,
        Enabled: true,
        Reason: null,
        ConnectionId: "cds-primary");

    private static DesignArtifactLifecycleExpectation Expected(DesignArtifactRun run) => new(
        run.LifecycleVersion,
        run.WorkspaceRef?.BaseRevision,
        run.VersionBoundary?.BaseContentHash);

    private static DesignArtifactLifecycleLeaseAuthority ActiveLease(DesignArtifactRun run) => new(
        run.LeaseOwnerId ?? throw new InvalidOperationException("测试任务缺少租约"));

    private static async Task<(DesignArtifactRun? Run, DesignArtifactLifecycleException? Error)> TryStartAsync(
        IDesignArtifactLifecycleService lifecycle,
        DesignArtifactRun run,
        DesignArtifactLifecycleExpectation expected,
        string leaseOwner)
    {
        try
        {
            return (await lifecycle.StartAsync(new StartDesignArtifactSessionRequest(
                run.Id,
                run.UserId,
                expected,
                leaseOwner,
                DateTime.UtcNow.AddMinutes(2))), null);
        }
        catch (DesignArtifactLifecycleException ex)
        {
            return (null, ex);
        }
    }

    private static string Sha256Hex(byte[] content) =>
        Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant();

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private Fixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<Fixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new Fixture(client, connectionString, $"web_page_lifecycle_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync()
        {
            await _client.DropDatabaseAsync(_databaseName);
        }
    }
}
