using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.MdToPpt;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[CollectionDefinition("Design deployment environment", DisableParallelization = true)]
public sealed class DesignDeploymentEnvironmentCollection;

/// <summary>只在显式 loopback 独立 Mongo 上写随机合成库，不读取应用连接或调用模型。</summary>
[Collection("Design deployment environment")]
public sealed class DesignArtifactDeploymentIsolationTests : IAsyncLifetime
{
    private const string CurrentScope = "project-a::branch-a::revision::revision-a";
    private readonly Dictionary<string, string?> _previousEnvironment = new();
    private MongoDbContext _db = null!;
    private LlmGatewayDataContext _gateway = null!;
    private readonly InMemoryRunEventStore _events = new();
    private readonly InMemoryRunQueue _queue = new();
    private string _databaseName = "";
    private string _connection = "";
    private static DateTime Now => new(DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond * TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);

    public async Task InitializeAsync()
    {
        _connection = Environment.GetEnvironmentVariable("DESIGN_RUN_MONGO_TEST_CONNECTION") ?? "";
        var url = new MongoUrl(_connection);
        Assert.Single(url.Servers);
        Assert.Equal("127.0.0.1", url.Server.Host);
        Assert.Equal(27389, url.Server.Port);
        Assert.Null(url.Username);
        _databaseName = $"design_scope_synthetic_{Guid.NewGuid():N}";
        _db = new MongoDbContext(_connection, _databaseName);
        _gateway = new LlmGatewayDataContext(_connection, _databaseName);
        Assert.Empty(await (await _db.Database.ListCollectionNamesAsync()).ToListAsync());
        foreach (var (name, value) in new[] { ("CDS_PROJECT_ID", "project-a"), ("VITE_GIT_BRANCH", "branch-a"), ("GIT_COMMIT", "revision-a") })
        {
            _previousEnvironment[name] = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, value);
        }
        Assert.Equal(CurrentScope, DeploymentScope.Current);
    }

    [DesignScopeMongoFact]
    public async Task NewCollection_IsInvisibleToLegacyWorkers_AndDoesNotStampDeserializedHistory()
    {
        Assert.Equal("design_artifact_runs_v2", _db.DesignArtifactRuns.CollectionNamespace.CollectionName);
        var run = Run("new-run", RunStatuses.Queued);
        await InsertAsync(run, CurrentScope);
        Assert.Empty(await _db.Database.GetCollection<DesignArtifactRun>("design_artifact_runs")
            .Find(item => item.Status == RunStatuses.Queued).ToListAsync());
        var old = new BsonDocument { { "_id", "legacy-missing-scope" }, { "UserId", "owner" } };
        var read = MongoDB.Bson.Serialization.BsonSerializer.Deserialize<DesignArtifactRun>(old).ToBsonDocument();
        Assert.True(!read.TryGetValue("DeploymentSlug", out var scope) || scope.IsBsonNull);
    }

    [DesignScopeMongoTheory]
    [InlineData("project-b::branch-a::revision::revision-a")]
    [InlineData("project-a::branch-b::revision::revision-a")]
    [InlineData("project-a::branch-a::revision::revision-b")]
    [InlineData(null)]
    public async Task ClaimAndLeaseWrites_RejectForeignDeployment(string? otherScope)
    {
        var now = Now;
        var queued = Run("foreign-queued", RunStatuses.Queued);
        await InsertAsync(queued, otherScope);
        Assert.Null(await HostedSiteEditRunWorker.TryClaimAsync(_db, queued.Id, "worker", now, TimeSpan.FromMinutes(2), default));

        var active = Run("foreign-active", RunStatuses.Running);
        active.LeaseOwnerId = "worker";
        active.LeaseExpiresAt = now.AddMinutes(2);
        await InsertAsync(active, otherScope);
        Assert.False(await HostedSiteEditRunWorker.RenewLeaseAsync(_db, active.Id, "worker", now, TimeSpan.FromMinutes(2), default));
        Assert.False(await HostedSiteEditRunWorker.PersistPhaseAsync(_db, active.Id, "worker", 50, "异部署不得写入", now, default));
        Assert.False(await HostedSiteEditRunWorker.BeginCommitAsync(_db, active.Id, "worker", now, TimeSpan.FromMinutes(2), default));

        active.Id = "foreign-committing";
        active.Status = RunStatuses.Committing;
        await InsertAsync(active, otherScope);
        Assert.False(await HostedSiteEditRunWorker.CompleteRunAsync(_db, active.Id, "worker", "site", "revision", "完成", now, default));

        var owned = Run("owned-queued", RunStatuses.Queued);
        await InsertAsync(owned, CurrentScope);
        Assert.NotNull(await HostedSiteEditRunWorker.TryClaimAsync(_db, owned.Id, "worker", now, TimeSpan.FromMinutes(2), default));
        Assert.True(await HostedSiteEditRunWorker.RenewLeaseAsync(_db, owned.Id, "worker", now, TimeSpan.FromMinutes(2), default));
    }

    [DesignScopeMongoTheory]
    [InlineData("project-b::branch-a::revision::revision-a")]
    [InlineData("project-a::branch-b::revision::revision-a")]
    [InlineData("project-a::branch-a::revision::revision-b")]
    public async Task Recovery_RequeuesOnlyOwnedRuns_AndLeavesForeignExecutionAndCleanupUnchanged(string otherScope)
    {
        var now = Now;
        foreach (var scope in new[] { CurrentScope, otherScope })
        {
            var prefix = scope == CurrentScope ? "owned" : "foreign";
            await InsertAsync(Run($"{prefix}-queued", RunStatuses.Queued), scope);
            var active = Run($"{prefix}-active", RunStatuses.Running);
            active.LeaseOwnerId = "retired-worker";
            active.LeaseExpiresAt = now.AddMinutes(-1);
            await InsertAsync(active, scope);
            var rejected = Run($"{prefix}-rejected", RunStatuses.Error);
            rejected.WorkspaceRejectedResultAssetKey = $"{prefix}-object";
            await InsertAsync(rejected, scope);
        }
        var before = await Raw("foreign-active");
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(item => item.DeleteByKeyAsync("owned-object", CancellationToken.None)).Returns(Task.CompletedTask);
        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(_db, _queue, _events, now, default, workspaceStorage: storage.Object);
        Assert.Equal("owned-queued", await _queue.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Null(await _queue.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Equal(before, await Raw("foreign-active"));
        Assert.Equal(RunStatuses.Error, (await Read("owned-active")).Status);
        Assert.Equal("foreign-object", (await Read("foreign-rejected")).WorkspaceRejectedResultAssetKey);
        Assert.Null((await Read("owned-rejected")).WorkspaceRejectedResultAssetKey);
        storage.Verify(item => item.DeleteByKeyAsync("owned-object", CancellationToken.None), Times.Once);
        storage.VerifyNoOtherCalls();
    }

    [DesignScopeMongoFact]
    public async Task LegacyHistory_RemainsReadableThroughAllPublicReads_ButCannotCancelOrAdvanceLifecycle()
    {
        var legacy = _db.Database.GetCollection<DesignArtifactRun>("design_artifact_runs");
        var done = Run("legacy-done", RunStatuses.Error);
        done.ContractVersion = DesignArtifactContractVersions.Current;
        done.LifecycleEvents = [new() { RunId = done.Id, Sequence = 1, Type = "error", Authoritative = true }];
        done.CompletedAt = Now;
        await legacy.InsertOneAsync(done);
        var queued = Run("legacy-queued", RunStatuses.Queued);
        queued.ContractVersion = DesignArtifactContractVersions.Current;
        await legacy.InsertOneAsync(queued);
        var before = await legacy.Find(item => item.Id == queued.Id).FirstAsync();
        var generation = GenerationController();
        Assert.IsType<OkObjectResult>(await generation.GetRun(done.Id));
        Assert.IsType<OkObjectResult>(await generation.GetContract(done.Id));
        Assert.IsType<OkObjectResult>(await generation.GetContractEvents(done.Id));
        Assert.IsType<OkObjectResult>(await generation.GetEvidence(done.Id));
        await generation.StreamRun(done.Id);
        Assert.Contains("event: error", await ReadResponse(generation));
        Assert.IsType<NotFoundObjectResult>(await generation.CancelRun(queued.Id));
        Assert.Null(await new DesignArtifactCancellationCoordinator(_db, Lifecycle()).RequestAsync(queued.Id, "owner"));
        var exception = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() => Lifecycle().AppendEventAsync(
            new AppendDesignArtifactEventRequest(queued.Id, "owner", DesignArtifactLifecycleEventTypes.Phase, "不应写入", 1)));
        Assert.Equal(DesignArtifactLifecycleErrorCodes.NotFound, exception.Code);
        Assert.Equal(before.ToBsonDocument(), (await legacy.Find(item => item.Id == queued.Id).FirstAsync()).ToBsonDocument());

        done.Id = "legacy-edit-done";
        done.Operation = DesignArtifactOperations.Edit;
        done.TargetSiteId = "site";
        await legacy.InsertOneAsync(done);
        queued.Id = "legacy-edit-queued";
        queued.Operation = DesignArtifactOperations.Edit;
        queued.TargetSiteId = "site";
        await legacy.InsertOneAsync(queued);
        var edit = EditController();
        Assert.IsType<OkObjectResult>(await edit.GetRun("site", done.Id));
        await edit.StreamRun("site", done.Id);
        Assert.Contains("event: error", await ReadResponse(edit));
        Assert.IsType<NotFoundObjectResult>(await edit.CancelRun("site", queued.Id));
    }

    [DesignScopeMongoTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SharedWorkspaceObject_ReferencedByForeignOrLegacyHistory_IsNeverDeleted(bool legacyReference)
    {
        var pending = Run("pending", RunStatuses.Error);
        pending.WorkspacePendingResultAssetKey = "shared-object";
        pending.WorkspacePendingResultAttemptId = "attempt";
        pending.WorkspacePendingResultWriteState = DesignWorkspaceResultWriteStates.Stored;
        await InsertAsync(pending, CurrentScope);
        var winner = Run("winner", RunStatuses.Done);
        winner.WorkspaceResultAssetKey = "shared-object";
        if (legacyReference)
            await _db.Database.GetCollection<DesignArtifactRun>("design_artifact_runs").InsertOneAsync(winner);
        else
            await InsertAsync(winner, "project-b::branch-a::revision::revision-a");
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        Assert.True(await DesignArtifactWorkspaceBroker.RecoverPendingWorkspaceResultAsync(_db, storage.Object, pending, Now, default));
        Assert.Null((await Read(pending.Id)).WorkspacePendingResultAssetKey);
        storage.VerifyNoOtherCalls();
    }

    [DesignScopeMongoFact]
    public async Task AllThreeCreationEntrypoints_FreezeCurrentScopeInTheNewCollection()
    {
        var provider = new Mock<IDesignArtifactProviderCatalog>();
        provider.Setup(item => item.FindAsync("owner", DesignArtifactRuntimes.MapGateway, CancellationToken.None))
            .ReturnsAsync(new DesignArtifactProviderCapability(
                DesignArtifactRuntimes.MapGateway, "测试执行器", DesignArtifactAdapterKinds.RemoteAgent,
                DesignArtifactExecutionOwners.CdsRemoteAgent, DesignArtifactIsolationModes.SessionContainer,
                [DesignArtifactTypes.WebPage], [DesignArtifactOperations.Generate, DesignArtifactOperations.Edit],
                [DesignArtifactSourceSurfaces.WebHosting], true, true, true, null));
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>();
        knowledge.Setup(item => item.ResolveForRunAsync("owner", It.IsAny<IReadOnlyList<DesignKnowledgeReferenceIdentity>>(), CancellationToken.None))
            .ReturnsAsync(new List<DesignKnowledgeSnapshot> { new() { EntryId = "entry", StoreId = "store", ContentHash = new string('a', 64) } });
        var generation = WithUser(new DesignArtifactsController(
            _db, _events, _queue, provider.Object, knowledge.Object, _gateway,
            new DesignArtifactCancellationCoordinator(_db, Lifecycle()), new ConfigurationBuilder().Build()));
        Assert.IsType<AcceptedResult>(await generation.CreateRun(new CreateDesignArtifactRunRequest {
            ArtifactType = DesignArtifactTypes.WebPage, Instruction = "生成测试网页",
            KnowledgeReferences = [new() { EntryId = "entry", StoreId = "store" }] }));
        var sites = new Mock<IHostedSiteService>();
        sites.Setup(item => item.GetEditableEntryHtmlAsync("site", "owner", CancellationToken.None))
            .ReturnsAsync(new HostedSiteEditableEntry(new HostedSite { Id = "site", OwnerUserId = "owner",
                Files = [new() { Path = "index.html", CosKey = "site/index.html", MimeType = "text/html" }] },
                "<!doctype html><html><body>测试</body></html>", Now));
        var edit = WithUser(new HostedSiteEditsController(sites.Object, Mock.Of<IHostedSiteRevisionService>(),
            _events, _queue, _db, NullLogger<HostedSiteEditsController>.Instance, provider.Object, knowledge.Object,
            Mock.Of<IWebPageDesignArtifactLifecycleAdapter>(), new DesignArtifactCancellationCoordinator(_db, Lifecycle()),
            new ConfigurationBuilder().Build()));
        Assert.IsType<AcceptedResult>(await edit.CreateRun("site", new CreateHostedSiteEditRunRequest { Instruction = "修改测试网页" }));
        await Lifecycle().CreateSessionAsync(new CreateDesignArtifactSessionRequest(
            "lifecycle-created", "owner", DesignArtifactTypes.HtmlPpt, DesignArtifactOperations.Generate,
            DesignArtifactSourceSurfaces.HtmlPpt, DesignArtifactRuntimes.HtmlPptPipeline,
            new DesignArtifactWorkspaceRef { WorkspaceId = "workspace", Kind = DesignArtifactWorkspaceKinds.AdapterOwned,
                BaseRevision = "base", Adapter = "html-ppt" },
            new DesignArtifactVersionBoundary { BaseContentHash = new string('b', 64) },
            new DesignArtifactCapabilitySnapshot {
                CapabilityId = "html-ppt.v1", ArtifactType = DesignArtifactTypes.HtmlPpt,
                Runtime = DesignArtifactRuntimes.HtmlPptPipeline, Adapter = "html-ppt",
                WorkspaceKind = DesignArtifactWorkspaceKinds.AdapterOwned,
                SecurityProfile = DesignArtifactSecurityProfiles.HtmlPptInteractive,
                Operations = [DesignArtifactOperations.Generate], SourceSurfaces = [DesignArtifactSourceSurfaces.HtmlPpt] }));
        var runs = await _db.DesignArtifactRuns.Find(FilterDefinition<DesignArtifactRun>.Empty).ToListAsync();
        Assert.Equal(3, runs.Count);
        Assert.All(runs, run => Assert.Equal(CurrentScope, run.DeploymentSlug));
        Assert.Empty(await _db.Database.GetCollection<DesignArtifactRun>("design_artifact_runs")
            .Find(FilterDefinition<DesignArtifactRun>.Empty).ToListAsync());
    }

    [DesignScopeMongoTheory]
    [InlineData("legacy")]
    [InlineData("foreign")]
    [InlineData("orphan")]
    public async Task HtmlPptRecovery_DoesNotRewriteForeignLegacyOrUnownedSourceRuns(string origin)
    {
        var source = new MdToPptRun {
            Id = "ppt-source", UserId = "owner", Status = "running", Op = "convert",
            Runtime = DesignArtifactRuntimes.HtmlPptPipeline, Provider = "open-design-html-ppt",
            ArtifactContractVersion = DesignArtifactContractVersions.Current, Title = "测试",
            SourceSurface = DesignArtifactSourceSurfaces.HtmlPpt, UpdatedAt = Now.AddMinutes(-30) };
        await _db.MdToPptRuns.InsertOneAsync(source);
        var original = source.ToBsonDocument();
        if (origin != "orphan")
        {
            var ledger = Run(source.Id, RunStatuses.Running);
            ledger.ArtifactType = DesignArtifactTypes.HtmlPpt;
            ledger.Runtime = DesignArtifactRuntimes.HtmlPptPipeline;
            ledger.SourceSurface = DesignArtifactSourceSurfaces.HtmlPpt;
            ledger.ContractVersion = DesignArtifactContractVersions.Current;
            if (origin == "legacy")
                await _db.Database.GetCollection<DesignArtifactRun>("design_artifact_runs").InsertOneAsync(ledger);
            else
                await InsertAsync(ledger, "project-a::branch-a::revision::retired");
        }
        var adapter = new HtmlPptDesignArtifactAdapter(_db, Lifecycle(), NullLogger<HtmlPptDesignArtifactAdapter>.Instance);
        Assert.Equal(0, await adapter.RecoverPendingAsync());
        Assert.Equal(original, (await _db.MdToPptRuns.Find(item => item.Id == source.Id).FirstAsync()).ToBsonDocument());
        Assert.False(await _db.DesignArtifactRuns.Find(item => item.Id == source.Id && item.DeploymentSlug == CurrentScope).AnyAsync());
        if (origin != "orphan")
            await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() => adapter.BeginAsync(source));
        Assert.False(await _db.DesignArtifactRuns.Find(item => item.Id == source.Id && item.DeploymentSlug == CurrentScope).AnyAsync());
    }

    [DesignScopeMongoFact]
    public async Task HtmlPptRecovery_FiltersForeignAndOrphanBacklogBeforeLimit()
    {
        var adapter = new HtmlPptDesignArtifactAdapter(_db, Lifecycle(), NullLogger<HtmlPptDesignArtifactAdapter>.Instance);
        foreach (var id in new[] { "foreign-oldest", "orphan-next", "owned-latest" })
        {
            var source = new MdToPptRun {
                Id = id, UserId = "owner", Status = "error", Op = "convert",
                Runtime = DesignArtifactRuntimes.HtmlPptPipeline, Provider = "open-design-html-ppt",
                ArtifactContractVersion = DesignArtifactContractVersions.Current, Title = "测试",
                SourceSurface = DesignArtifactSourceSurfaces.HtmlPpt,
                UpdatedAt = Now.AddMinutes(id == "owned-latest" ? -20 : -40) };
            await _db.MdToPptRuns.InsertOneAsync(source);
            if (id == "foreign-oldest")
                await InsertAsync(Run(id, RunStatuses.Running), "project-b::branch-a::revision::revision-a");
            if (id == "owned-latest") await adapter.BeginAsync(source);
        }
        var before = await _db.MdToPptRuns.Find(item => item.Id != "owned-latest").SortBy(item => item.Id).ToListAsync();
        Assert.Equal(1, await adapter.RecoverPendingAsync(limit: 1));
        Assert.NotNull((await _db.MdToPptRuns.Find(item => item.Id == "owned-latest").FirstAsync()).ArtifactContractSynchronizedAt);
        var after = await _db.MdToPptRuns.Find(item => item.Id != "owned-latest").SortBy(item => item.Id).ToListAsync();
        Assert.Equal(before.Select(item => item.ToBsonDocument()), after.Select(item => item.ToBsonDocument()));
    }

    private DesignArtifactLifecycleService Lifecycle() => new(_db, _events);
    private DesignArtifactsController GenerationController() => WithUser(new DesignArtifactsController(
        _db, _events, _queue, Mock.Of<IDesignArtifactProviderCatalog>(), Mock.Of<IDesignKnowledgeSnapshotResolver>(),
        _gateway, new DesignArtifactCancellationCoordinator(_db, Lifecycle()), new ConfigurationBuilder().Build()));
    private HostedSiteEditsController EditController() => WithUser(new HostedSiteEditsController(
        Mock.Of<IHostedSiteService>(), Mock.Of<IHostedSiteRevisionService>(), _events, _queue, _db,
        NullLogger<HostedSiteEditsController>.Instance, Mock.Of<IDesignArtifactProviderCatalog>(),
        Mock.Of<IDesignKnowledgeSnapshotResolver>(), Mock.Of<IWebPageDesignArtifactLifecycleAdapter>(),
        new DesignArtifactCancellationCoordinator(_db, Lifecycle()), new ConfigurationBuilder().Build()));
    private static T WithUser<T>(T controller) where T : ControllerBase
    {
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
            User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", "owner")], "test")) } };
        controller.Response.Body = new MemoryStream();
        return controller;
    }
    private static async Task<string> ReadResponse(ControllerBase controller)
    {
        controller.Response.Body.Position = 0;
        return await new StreamReader(controller.Response.Body, leaveOpen: true).ReadToEndAsync();
    }
    private static DesignArtifactRun Run(string id, string status) => new()
    {
        Id = id, UserId = "owner", Status = status, CreatedAt = Now.AddMinutes(-10), UpdatedAt = Now.AddMinutes(-5),
    };
    private Task InsertAsync(DesignArtifactRun run, string? scope)
    {
        var document = run.ToBsonDocument();
        document["DeploymentSlug"] = scope == null ? BsonNull.Value : scope;
        return _db.Database.GetCollection<BsonDocument>(_db.DesignArtifactRuns.CollectionNamespace.CollectionName).InsertOneAsync(document);
    }
    private Task<DesignArtifactRun> Read(string id) => _db.DesignArtifactRuns.Find(item => item.Id == id).FirstAsync();
    private Task<BsonDocument> Raw(string id) => _db.Database.GetCollection<BsonDocument>(
        _db.DesignArtifactRuns.CollectionNamespace.CollectionName).Find(new BsonDocument("_id", id)).FirstAsync();
    public async Task DisposeAsync()
    {
        foreach (var (name, value) in _previousEnvironment) Environment.SetEnvironmentVariable(name, value);
        if (_databaseName.StartsWith("design_scope_synthetic_", StringComparison.Ordinal))
            await new MongoClient(_connection).DropDatabaseAsync(_databaseName);
    }
}

public sealed class DesignScopeMongoFactAttribute : FactAttribute
{
    public DesignScopeMongoFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DESIGN_RUN_MONGO_TEST_CONNECTION")))
            Skip = "需要独立 Mongo 127.0.0.1:27389 与显式 DESIGN_RUN_MONGO_TEST_CONNECTION；不连接应用 Mongo。";
    }
}
public sealed class DesignScopeMongoTheoryAttribute : TheoryAttribute
{
    public DesignScopeMongoTheoryAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DESIGN_RUN_MONGO_TEST_CONNECTION")))
            Skip = "需要独立 Mongo 127.0.0.1:27389 与显式 DESIGN_RUN_MONGO_TEST_CONNECTION；不连接应用 Mongo。";
    }
}
