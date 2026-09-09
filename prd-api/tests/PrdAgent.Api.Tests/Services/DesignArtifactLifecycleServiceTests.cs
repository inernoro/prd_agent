using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;
using LifecycleManifest = PrdAgent.Core.Models.DesignArtifactContractManifest;
using LifecycleManifestFile = PrdAgent.Core.Models.DesignArtifactContractManifestFile;

namespace PrdAgent.Api.Tests.Services;

public sealed class DesignArtifactLifecycleServiceTests
{
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task MapEditOfPreviouslyHardenedPage_ShouldCreateReadableDraftWithOneSystemCsp()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var now = DateTime.UtcNow;
        var originalHtml = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html lang=\"zh-CN\"><head><title>社区服务</title><style>header{background:#334155}</style></head><body><header><h1>社区服务</h1></header><main><p>开放安排与服务规则保持不变。</p></main></body></html>");
        var site = new HostedSite
        {
            Id = "site-hardened-map-edit",
            OwnerUserId = "owner-user",
            ContentVersion = now,
        };
        var editable = new HostedSiteEditableEntry(site, originalHtml, now);
        var parent = new HostedSiteRevision
        {
            Id = "revision-parent",
            SiteId = site.Id,
            CreatedByUserId = site.OwnerUserId,
            Html = originalHtml,
            BasedOnContentVersion = now,
        };
        var run = new DesignArtifactRun
        {
            Id = "run-hardened-map-edit",
            UserId = site.OwnerUserId,
            Operation = DesignArtifactOperations.Edit,
            Runtime = DesignArtifactRuntimes.MapGateway,
            TargetSiteId = site.Id,
            Instruction = "只把页眉背景改为 #12665a，其他不变",
            CreatedAt = now,
            UpdatedAt = now,
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);

        var sites = new Mock<IHostedSiteService>();
        sites.Setup(service => service.GetEditableEntryHtmlAsync(site.Id, run.UserId, CancellationToken.None))
            .ReturnsAsync(editable);
        var revisions = new Mock<IHostedSiteRevisionService>();
        revisions.Setup(service => service.EnsureCurrentSnapshotAsync(
                site.Id, run.UserId, editable, It.IsAny<CancellationToken>()))
            .ReturnsAsync(parent);
        HostedSiteRevision? savedDraft = null;
        revisions.Setup(service => service.CreateDraftAsync(
                site.Id,
                run.UserId,
                It.IsAny<string>(),
                run.Instruction,
                run.Runtime,
                run.Id,
                parent.Id,
                It.IsAny<IReadOnlyCollection<string>>(),
                now,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync((string _, string _, string html, string _, string _, string _, string _,
                IReadOnlyCollection<string> _, DateTime _, CancellationToken _) =>
            {
                savedDraft = new HostedSiteRevision
                {
                    Id = "revision-map-draft",
                    SiteId = site.Id,
                    CreatedByUserId = run.UserId,
                    Status = HostedSiteRevisionStatuses.Draft,
                    SourceRunId = run.Id,
                    Html = html,
                    BasedOnContentVersion = now,
                };
                return savedDraft;
            });
        var executor = new CspPreservingMapEditExecutor();
        var services = new ServiceCollection();
        services.AddSingleton(fixture.Db);
        services.AddSingleton(sites.Object);
        services.AddSingleton(revisions.Object);
        services.AddSingleton(Mock.Of<IWebPageDesignArtifactLifecycleAdapter>());
        services.AddSingleton(Mock.Of<IDesignArtifactLifecycleService>());
        services.AddSingleton(Mock.Of<IDesignKnowledgeSnapshotResolver>());
        services.AddSingleton(Mock.Of<IActivityActionRecorder>());
        services.AddSingleton<IDesignArtifactExecutor>(executor);
        using var provider = services.BuildServiceProvider();
        using var worker = new HostedSiteEditRunWorker(
            provider.GetRequiredService<IServiceScopeFactory>(),
            Mock.Of<IRunQueue>(),
            new InMemoryRunEventStore(),
            NullLogger<HostedSiteEditRunWorker>.Instance);

        await worker.ProcessAsync(run.Id, CancellationToken.None);

        Assert.NotNull(executor.InputHtml);
        Assert.DoesNotContain("Content-Security-Policy", executor.InputHtml, StringComparison.OrdinalIgnoreCase);
        Assert.NotNull(savedDraft);
        Assert.Equal(HostedSiteRevisionStatuses.Draft, savedDraft.Status);
        Assert.Contains("#12665a", savedDraft.Html, StringComparison.Ordinal);
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(
                savedDraft.Html,
                "Content-Security-Policy",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            .Cast<System.Text.RegularExpressions.Match>());
        var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Done, persisted.Status);
        Assert.Equal(site.Id, persisted.ArtifactSiteId);
        Assert.Equal(savedDraft.Id, persisted.ArtifactRevisionId);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task Worker_ShouldNotClaimOrPublishWhileCleanupOwnsResources()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var now = DateTime.UtcNow;
        var run = new DesignArtifactRun
        {
            Id = "cleanup-fence", UserId = "owner-user", Status = RunStatuses.Queued,
            ContractVersion = DesignArtifactContractVersions.Current,
            LeaseOwnerId = "worker-a", LeaseExpiresAt = now.AddMinutes(2),
            CleanupLeaseOwnerId = "cleanup-a", CleanupLeaseExpiresAt = now.AddMinutes(1),
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        Assert.Null(await HostedSiteEditRunWorker.TryClaimAsync(fixture.Db, run.Id, "worker-b", now,
            TimeSpan.FromMinutes(2), CancellationToken.None));
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(item => item.Id == run.Id,
            Builders<DesignArtifactRun>.Update.Set(item => item.Status, RunStatuses.Committing));

        Assert.False(await HostedSiteEditRunWorker.BeginCommitAsync(fixture.Db, run.Id, "worker-a", now,
            TimeSpan.FromMinutes(2), CancellationToken.None));
        Assert.False(await HostedSiteEditRunWorker.RenewLeaseAsync(fixture.Db, run.Id, "worker-a", now,
            TimeSpan.FromMinutes(2), CancellationToken.None));
        Assert.False(await HostedSiteEditRunWorker.RecordProducedArtifactAsync(fixture.Db, run.Id, "worker-a",
            "site-a", "revision-a", CancellationToken.None));
        Assert.False(await HostedSiteEditRunWorker.CompleteRunAsync(fixture.Db, run.Id, "worker-a",
            "site-a", "revision-a", "完成", now, CancellationToken.None));
        var current = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Committing, current.Status);
        Assert.Null(current.ProducedArtifactSiteId);
        Assert.Null(current.ArtifactSiteId);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task LeaseRenewal_InSameMillisecond_ShouldRemainOwned()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var now = DateTimeOffset.FromUnixTimeMilliseconds(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).UtcDateTime;
        var run = new DesignArtifactRun
        {
            Id = "same-millisecond", UserId = "owner-user", Status = RunStatuses.Running,
            LeaseOwnerId = "worker-a", LeaseExpiresAt = now.AddMinutes(2), HeartbeatAt = now, UpdatedAt = now,
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);

        Assert.True(await HostedSiteEditRunWorker.RenewLeaseAsync(fixture.Db, run.Id, "worker-a", now,
            TimeSpan.FromMinutes(2), CancellationToken.None));
        Assert.False(await HostedSiteEditRunWorker.RenewLeaseAsync(fixture.Db, run.Id, "worker-b", now,
            TimeSpan.FromMinutes(2), CancellationToken.None));
    }

    [Theory]
    [InlineData("metadata")]
    [InlineData("phase")]
    [InlineData("thinking")]
    [InlineData("delta")]
    [InlineData("done")]
    [Trait("Category", TestCategories.Integration)]
    public async Task Worker_RedisFailureDuringExecution_ShouldStillPersistOneCompletedArtifact(string failurePoint)
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var run = new DesignArtifactRun
        {
            Id = "projection-outage", UserId = "owner-user", Instruction = "生成说明网页", Title = "说明网页",
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var events = new Mock<IRunEventStore>();
        events.Setup(store => store.GetRunAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("redis read unavailable"));
        if (failurePoint == "metadata")
            events.Setup(store => store.SetRunAsync(It.IsAny<string>(), It.IsAny<RunMeta>(), It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()))
                .ThrowsAsync(new InvalidOperationException("redis metadata unavailable"));
        events.Setup(store => store.AppendEventAsync(It.IsAny<string>(), run.Id, failurePoint, It.IsAny<object>(),
                It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("redis stream unavailable"));
        var sites = new Mock<IHostedSiteService>();
        var site = new HostedSite { Id = "persisted-site", OwnerUserId = run.UserId, Title = run.Title! };
        sites.Setup(service => service.CreateFromContentAsync(run.UserId, It.IsAny<string>(), run.Title,
                It.IsAny<string>(), "design-agent", run.Id, It.IsAny<List<string>>(), null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(site);
        sites.Setup(service => service.GetEditableEntryHtmlAsync(site.Id, run.UserId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(site, ProjectionTestHtml, DateTime.UtcNow));
        var revisions = new Mock<IHostedSiteRevisionService>();
        revisions.Setup(service => service.EnsureGeneratedSnapshotAsync(site.Id, run.UserId,
                It.IsAny<HostedSiteEditableEntry>(), run.Runtime, run.Id, It.IsAny<IReadOnlyCollection<string>>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteRevision { Id = "persisted-revision", SiteId = site.Id, Status = HostedSiteRevisionStatuses.Published });
        var services = new ServiceCollection();
        services.AddSingleton(fixture.Db);
        services.AddSingleton(sites.Object);
        services.AddSingleton(revisions.Object);
        services.AddSingleton(Mock.Of<IWebPageDesignArtifactLifecycleAdapter>());
        services.AddSingleton(Mock.Of<IDesignArtifactLifecycleService>());
        services.AddSingleton(Mock.Of<IDesignKnowledgeSnapshotResolver>());
        services.AddSingleton(Mock.Of<IActivityActionRecorder>());
        services.AddSingleton<IDesignArtifactExecutor>(new ProjectionTestExecutor());
        using var provider = services.BuildServiceProvider();
        using var worker = new HostedSiteEditRunWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Mock.Of<IRunQueue>(), events.Object, NullLogger<HostedSiteEditRunWorker>.Instance);

        await worker.ProcessAsync(run.Id, CancellationToken.None);

        var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Done, persisted.Status);
        Assert.Equal(100, persisted.Progress);
        Assert.Equal(site.Id, persisted.ArtifactSiteId);
        Assert.Equal("persisted-revision", persisted.ArtifactRevisionId);
        Assert.Null(persisted.Error);
        sites.Verify(service => service.CreateFromContentAsync(run.UserId, It.IsAny<string>(), run.Title,
            It.IsAny<string>(), "design-agent", run.Id, It.IsAny<List<string>>(), null, It.IsAny<CancellationToken>()), Times.Once);
        sites.Verify(service => service.CompensateGeneratedSiteAsync(It.IsAny<string>(), It.IsAny<string>(),
            It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
        events.Verify(store => store.GetRunAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
        if (failurePoint != "metadata")
            events.Verify(store => store.AppendEventAsync(It.IsAny<string>(), run.Id, failurePoint, It.IsAny<object>(),
                It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()), Times.Once);
    }

    private const string ProjectionTestHtml = "<!doctype html><html lang=\"zh-CN\"><head><title>说明网页</title></head><body><main><h1>说明网页</h1><p>知识内容负责事实，页面展示帮助读者理解。</p></main></body></html>";

    private sealed class CspPreservingMapEditExecutor : IDesignArtifactExecutor
    {
        public string Runtime => DesignArtifactRuntimes.MapGateway;
        public string? InputHtml { get; private set; }
        public bool Supports(string artifactType, string operation) => operation == DesignArtifactOperations.Edit;

        public async IAsyncEnumerable<DesignArtifactExecutorChunk> ExecuteAsync(
            DesignArtifactRun run,
            string? currentHtml,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
        {
            await Task.Yield();
            InputHtml = currentHtml;
            yield return new DesignArtifactExecutorChunk(
                "delta",
                (currentHtml ?? string.Empty).Replace("#334155", "#12665a", StringComparison.Ordinal));
        }
    }

    private sealed class ProjectionTestExecutor : IDesignArtifactExecutor
    {
        public string Runtime => DesignArtifactRuntimes.MapGateway;
        public bool Supports(string artifactType, string operation) => true;
        public async IAsyncEnumerable<DesignArtifactExecutorChunk> ExecuteAsync(DesignArtifactRun run, string? currentHtml,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
        {
            await Task.Yield();
            yield return new DesignArtifactExecutorChunk("thinking", "正在整理结构");
            yield return new DesignArtifactExecutorChunk("delta", ProjectionTestHtml);
            yield return new DesignArtifactExecutorChunk("delta", "\n");
        }
    }

    [Fact]
    public void DesignArtifactRoutes_ShouldReuseWebPageReadWritePermissions()
    {
        var permission = Assert.Single(
            typeof(DesignArtifactsController).GetCustomAttributes(typeof(AdminControllerAttribute), true)
                .Cast<AdminControllerAttribute>());

        Assert.Equal(AdminPermissionCatalog.WebPagesRead, permission.ReadPermission);
        Assert.Equal(AdminPermissionCatalog.WebPagesWrite, permission.WritePermission);
    }

    [Fact]
    public void LifecycleServiceAndPublicReadRoutes_ShouldRemainWired()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !System.IO.File.Exists(Path.Combine(directory.FullName, "prd-api", "src", "PrdAgent.Api", "Program.cs")))
            directory = directory.Parent;
        if (directory == null) throw new InvalidOperationException("找不到仓库根目录");
        var program = System.IO.File.ReadAllText(Path.Combine(directory.FullName, "prd-api", "src", "PrdAgent.Api", "Program.cs"));
        var controller = System.IO.File.ReadAllText(Path.Combine(
            directory.FullName,
            "prd-api",
            "src",
            "PrdAgent.Api",
            "Controllers",
            "Api",
            "DesignArtifactsController.cs"));

        Assert.Contains("AddScoped<PrdAgent.Core.Interfaces.IDesignArtifactLifecycleService", program, StringComparison.Ordinal);
        Assert.Contains("PrdAgent.Infrastructure.Services.DesignArtifactLifecycleService", program, StringComparison.Ordinal);
        Assert.Contains("AddScoped<PrdAgent.Api.Services.IDesignArtifactCancellationCoordinator", program, StringComparison.Ordinal);
        Assert.Contains("[HttpGet(\"runs/{runId}/contract\")]", controller, StringComparison.Ordinal);
        Assert.Contains("[HttpGet(\"runs/{runId}/contract/events\")]", controller, StringComparison.Ordinal);
        Assert.Contains("[HttpPost(\"runs/{runId}/cancel\")]", controller, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task RedisProjectionFailure_ShouldNotUndoMongoCreate()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var events = new Mock<IRunEventStore>();
        events.Setup(store => store.SetRunAsync(
                It.IsAny<string>(),
                It.IsAny<RunMeta>(),
                It.IsAny<TimeSpan?>(),
                It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("redis unavailable"));
        var service = new DesignArtifactLifecycleService(fixture.Db, events.Object);

        var created = await service.CreateSessionAsync(Session(
            "redis-failure",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));

        Assert.Equal(RunStatuses.Running, created.Status);
        Assert.Equal(1, created.LifecycleEventSequence);
        Assert.Single(created.LifecycleEvents);
        Assert.NotNull(await fixture.Db.DesignArtifactRuns.Find(item => item.Id == created.Id).SingleAsync());
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task CreateEndpoint_ShouldReturnDurableRunWhenRedisAndImmediateQueueAreUnavailable()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var policyConfiguration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["DesignArtifactRuntime:Model"] = "server-model", ["DesignArtifactRuntime:RequestPolicy:Temperature"] = "0.42" }).Build();
        var events = new Mock<IRunEventStore>();
        events.Setup(store => store.SetRunAsync(
                It.IsAny<string>(),
                It.IsAny<RunMeta>(),
                It.IsAny<TimeSpan?>(),
                It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("redis unavailable"));
        var queue = new Mock<IRunQueue>();
        queue.Setup(service => service.EnqueueAsync(
                RunKinds.DesignArtifact,
                It.IsAny<string>(),
                CancellationToken.None))
            .ThrowsAsync(new InvalidOperationException("queue unavailable"));
        var providers = new Mock<IDesignArtifactProviderCatalog>();
        providers.Setup(service => service.FindAsync(
                "owner-user",
                DesignArtifactRuntimes.MapGateway,
                CancellationToken.None))
            .ReturnsAsync(new DesignArtifactProviderCapability(
                DesignArtifactRuntimes.MapGateway,
                "MAP",
                DesignArtifactAdapterKinds.InProcess,
                DesignArtifactExecutionOwners.Map,
                DesignArtifactIsolationModes.Process,
                [DesignArtifactTypes.WebPage],
                [DesignArtifactOperations.Generate],
                [DesignArtifactSourceSurfaces.WebHosting],
                Configured: true,
                Healthy: true,
                Enabled: true,
                Reason: null));
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>();
        knowledge.Setup(service => service.ResolveForRunAsync(
                "owner-user",
                It.IsAny<IReadOnlyList<DesignKnowledgeReferenceIdentity>>(),
                CancellationToken.None))
            .ReturnsAsync([
                new DesignKnowledgeSnapshot
                {
                    EntryId = "entry-a",
                    StoreId = "store-a",
                    Title = "测试知识",
                    Content = "权威知识正文",
                    ContentHash = new string('a', 64),
                },
            ]);
        var controller = new DesignArtifactsController(
            fixture.Db,
            events.Object,
            queue.Object,
            providers.Object,
            knowledge.Object,
            new LlmGatewayDataContext(fixture.ConnectionString, fixture.GatewayDatabaseName),
            Mock.Of<IDesignArtifactCancellationCoordinator>(), policyConfiguration);
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", "owner-user")], "test")),
            },
        };

        var result = await controller.CreateRun(new CreateDesignArtifactRunRequest
        {
            ArtifactType = DesignArtifactTypes.WebPage,
            SourceSurface = DesignArtifactSourceSurfaces.WebHosting,
            Runtime = DesignArtifactRuntimes.MapGateway,
            Instruction = "生成产品说明网页",
            AdditionalProperties = new Dictionary<string, JsonElement>
            { ["llmRequestPolicy"] = JsonSerializer.SerializeToElement(new { model = "client-model", temperature = 1.9 }) },
            KnowledgeReferences =
            [
                new DesignKnowledgeReferenceRequest
                {
                    EntryId = "entry-a",
                    StoreId = "store-a",
                    ContentHash = new string('a', 64),
                },
            ],
        });

        Assert.IsType<AcceptedResult>(result);
        var persisted = await fixture.Db.DesignArtifactRuns.Find(_ => true).SingleAsync();
        Assert.Equal(RunStatuses.Queued, persisted.Status);
        Assert.Null(persisted.RecoveryEnqueuedAt);
        policyConfiguration["DesignArtifactRuntime:Model"] = "later-model";
        var reloaded = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == persisted.Id).SingleAsync();
        Assert.Equal("server-model", reloaded.LlmRequestPolicy!.Model);
        Assert.Equal(0.42, reloaded.LlmRequestPolicy.Temperature);
        Assert.Equal("server-model", DesignArtifactModelSelection.ForRun(reloaded, policyConfiguration).ForMapClient());
    }

    [Fact]
    public void MultiAssetPackageHash_ShouldChangeWhenSidecarChanges()
    {
        var first = Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'a');
        first.Files.Add(File("assets/theme.css", 'b'));
        var second = Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'a');
        second.Files.Add(File("assets/theme.css", 'c'));

        var firstHashes = DesignArtifactLifecycleService.ComputeManifestHashes(first);
        var secondHashes = DesignArtifactLifecycleService.ComputeManifestHashes(second);

        Assert.Equal(firstHashes.EntryContentHash, secondHashes.EntryContentHash);
        Assert.NotEqual(firstHashes.PackageHash, secondHashes.PackageHash);
        Assert.NotEqual(firstHashes.CanonicalManifestHash, secondHashes.CanonicalManifestHash);
    }

    [Theory]
    [InlineData(" index.html")]
    [InlineData("index.html ")]
    [InlineData("assets/%2e%2e/index.html")]
    [InlineData("assets/a?download=1")]
    [InlineData("assets/a#fragment")]
    [InlineData("CON")]
    [InlineData("assets/NUL.txt")]
    [InlineData("assets/a.")]
    [InlineData("other.html")]
    [Trait("Category", TestCategories.Integration)]
    public async Task Manifest_ShouldRejectAmbiguousCrossPlatformPaths(string path)
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var run = await service.CreateSessionAsync(Session(
            $"path-{Guid.NewGuid():N}",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        var manifest = Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'a', path);

        var error = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() =>
            service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
                run.Id,
                run.UserId,
                Expected(run),
                manifest,
                UnsafeReceipt(run, manifest))));

        Assert.Equal(DesignArtifactLifecycleErrorCodes.InvalidContract, error.Code);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task AdapterCannotForgeAuthoritativeOrTerminalEvents()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var run = await service.CreateSessionAsync(Session(
            "authoritative-event",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));

        var forged = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() =>
            service.AppendEventAsync(new AppendDesignArtifactEventRequest(
                run.Id,
                run.UserId,
                DesignArtifactLifecycleEventTypes.Published,
                "伪造发布",
                99)));
        Assert.Equal(DesignArtifactLifecycleErrorCodes.InvalidContract, forged.Code);

        var failed = await service.FailAsync(new FailDesignArtifactSessionRequest(
            run.Id,
            run.UserId,
            Expected(run),
            "adapter_failed"));
        await AssertConflict(() => service.AppendEventAsync(new AppendDesignArtifactEventRequest(
            failed.Id,
            failed.UserId,
            DesignArtifactLifecycleEventTypes.Phase,
            "终态后写入",
            99)));
        Assert.Equal(
            [DesignArtifactLifecycleEventTypes.Run, DesignArtifactLifecycleEventTypes.Error],
            failed.LifecycleEvents.Select(item => item.Type));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ActiveLeaseCannotBeBypassedByOmittingLeaseOwner()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var run = await service.CreateSessionAsync(Session(
            "lease-authority-required",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        var leaseExpiresAt = DateTime.UtcNow.AddMinutes(5);
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == run.Id,
            Builders<DesignArtifactRun>.Update
                .Set(item => item.LeaseOwnerId, "worker-authoritative")
                .Set(item => item.LeaseExpiresAt, leaseExpiresAt));
        var leased = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();

        await AssertConflict(() => service.AppendEventAsync(new AppendDesignArtifactEventRequest(
            leased.Id,
            leased.UserId,
            DesignArtifactLifecycleEventTypes.Phase,
            "不能绕过租约",
            10)));
        await AssertConflict(() => service.FailAsync(new FailDesignArtifactSessionRequest(
            leased.Id,
            leased.UserId,
            Expected(leased),
            "adapter_failed")));

        var unchanged = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Running, unchanged.Status);
        Assert.Equal(1, unchanged.LifecycleEventSequence);
        var authority = new DesignArtifactLifecycleExpectation(
            unchanged.LifecycleVersion,
            unchanged.WorkspaceRef!.BaseRevision,
            unchanged.VersionBoundary!.BaseContentHash,
            "worker-authoritative");
        var appended = await service.AppendEventAsync(new AppendDesignArtifactEventRequest(
            unchanged.Id,
            unchanged.UserId,
            DesignArtifactLifecycleEventTypes.Phase,
            "持有租约的阶段",
            10,
            authority));

        Assert.Equal(2, appended.Sequence);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task Cancellation_ShouldUseRequestThenOwnerFencedCancelledTerminal()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var created = await service.CreateSessionAsync(Session(
            "cancel-owner-fence",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design",
            DesignArtifactOperations.Edit));
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == created.Id,
            Builders<DesignArtifactRun>.Update.Set(item => item.Status, RunStatuses.Queued));
        var queued = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == created.Id).SingleAsync();
        var leaseExpiresAt = DateTime.UtcNow.AddMinutes(2);
        var running = await service.StartAsync(new StartDesignArtifactSessionRequest(
            queued.Id,
            queued.UserId,
            Expected(queued),
            "worker-owner",
            leaseExpiresAt));

        var requested = await service.RequestCancellationAsync(new RequestDesignArtifactCancellationRequest(
            running.Id,
            running.UserId,
            running.LifecycleVersion,
            running.WorkspaceRef!.BaseRevision,
            running.VersionBoundary!.BaseContentHash));

        Assert.Equal(RunStatuses.Running, requested.Status);
        Assert.NotNull(requested.CancelRequestedAt);
        Assert.Equal(requested.UserId, requested.CancelRequestedByUserId);
        Assert.Equal("worker-owner", requested.LeaseOwnerId);
        Assert.Equal(DesignArtifactLifecycleEventTypes.CancelRequested, requested.LifecycleEvents[^1].Type);
        await AssertConflict(() => service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
            requested.Id,
            requested.UserId,
            new DesignArtifactLifecycleExpectation(
                requested.LifecycleVersion,
                requested.WorkspaceRef!.BaseRevision,
                requested.VersionBoundary!.BaseContentHash,
                "worker-owner"),
            Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'a'),
            UnsafeReceipt(requested, Manifest(
                DesignArtifactTypes.WebPage,
                DesignArtifactSecurityProfiles.WebPageRestricted,
                'a')))));
        await AssertConflict(() => service.CancelAsync(new CancelDesignArtifactSessionRequest(
            requested.Id,
            requested.UserId,
            new DesignArtifactLifecycleExpectation(
                requested.LifecycleVersion,
                requested.WorkspaceRef!.BaseRevision,
                requested.VersionBoundary!.BaseContentHash,
                "different-worker"))));

        var cancelled = await service.CancelAsync(new CancelDesignArtifactSessionRequest(
            requested.Id,
            requested.UserId,
            new DesignArtifactLifecycleExpectation(
                requested.LifecycleVersion,
                requested.WorkspaceRef!.BaseRevision,
                requested.VersionBoundary!.BaseContentHash,
                "worker-owner")));

        Assert.Equal(RunStatuses.Cancelled, cancelled.Status);
        Assert.NotNull(cancelled.CancelledAt);
        Assert.Equal(cancelled.CancelledAt, cancelled.CompletedAt);
        Assert.Null(cancelled.Error);
        Assert.Null(cancelled.ProducedArtifactSiteId);
        Assert.Null(cancelled.ProducedArtifactRevisionId);
        Assert.Equal(DesignArtifactLifecycleEventTypes.Cancelled, cancelled.LifecycleEvents[^1].Type);
        Assert.True(cancelled.LifecycleEvents[^1].Authoritative);
        var idempotent = await service.RequestCancellationAsync(new RequestDesignArtifactCancellationRequest(
            cancelled.Id,
            cancelled.UserId,
            requested.LifecycleVersion,
            cancelled.WorkspaceRef!.BaseRevision,
            cancelled.VersionBoundary!.BaseContentHash));
        Assert.Equal(cancelled.LifecycleVersion, idempotent.LifecycleVersion);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task QueuedCancellation_ShouldBeImmediateAndCommittingCancellation_ShouldConflict()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var created = await service.CreateSessionAsync(Session(
            "cancel-queued",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == created.Id,
            Builders<DesignArtifactRun>.Update.Set(item => item.Status, RunStatuses.Queued));
        var queued = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == created.Id).SingleAsync();

        var cancelled = await service.RequestCancellationAsync(new RequestDesignArtifactCancellationRequest(
            queued.Id,
            queued.UserId,
            queued.LifecycleVersion,
            queued.WorkspaceRef!.BaseRevision,
            queued.VersionBoundary!.BaseContentHash));

        Assert.Equal(RunStatuses.Cancelled, cancelled.Status);
        Assert.NotNull(cancelled.CancelledAt);
        Assert.Equal(DesignArtifactLifecycleEventTypes.Cancelled, cancelled.LifecycleEvents[^1].Type);

        var committing = await service.CreateSessionAsync(Session(
            "cancel-committing",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == committing.Id,
            Builders<DesignArtifactRun>.Update.Set(item => item.Status, RunStatuses.Committing));
        committing = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == committing.Id).SingleAsync();
        await AssertConflict(() => service.RequestCancellationAsync(new RequestDesignArtifactCancellationRequest(
            committing.Id,
            committing.UserId,
            committing.LifecycleVersion,
            committing.WorkspaceRef!.BaseRevision,
            committing.VersionBoundary!.BaseContentHash)));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ResultReadyRecovery_ShouldRequireExactExpiredLeaseAndNoProducedArtifact()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var run = await service.CreateSessionAsync(Session(
            "resume-result-ready",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        var expiredAt = DateTime.UtcNow.AddMinutes(-1);
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == run.Id,
            Builders<DesignArtifactRun>.Update
                .Set(item => item.LeaseOwnerId, "dead-worker")
                .Set(item => item.LeaseExpiresAt, expiredAt)
                .Set(item => item.WorkspaceResultAssetKey, "trusted/result-ready.json"));
        run = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        var observedExpiry = run.LeaseExpiresAt!.Value;

        await AssertConflict(() => service.ResumeResultReadyAsync(new ResumeResultReadyDesignArtifactSessionRequest(
            run.Id,
            run.UserId,
            new DesignArtifactLifecycleExpectation(
                run.LifecycleVersion,
                run.WorkspaceRef!.BaseRevision,
                run.VersionBoundary!.BaseContentHash,
                "another-worker",
                expiredAt,
                Recovery: true))));

        await AssertConflict(() => service.ResumeResultReadyAsync(new ResumeResultReadyDesignArtifactSessionRequest(
            run.Id,
            run.UserId,
            new DesignArtifactLifecycleExpectation(
                run.LifecycleVersion,
                run.WorkspaceRef!.BaseRevision,
                run.VersionBoundary!.BaseContentHash,
                "dead-worker",
                observedExpiry.AddSeconds(-1),
                Recovery: true))));

        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == run.Id,
            Builders<DesignArtifactRun>.Update.Set(item => item.ProducedArtifactRevisionId, "already-written"));
        await AssertConflict(() => service.ResumeResultReadyAsync(new ResumeResultReadyDesignArtifactSessionRequest(
            run.Id,
            run.UserId,
            new DesignArtifactLifecycleExpectation(
                run.LifecycleVersion,
                run.WorkspaceRef!.BaseRevision,
                run.VersionBoundary!.BaseContentHash,
                "dead-worker",
                observedExpiry,
                Recovery: true))));
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == run.Id,
            Builders<DesignArtifactRun>.Update.Set(item => item.ProducedArtifactRevisionId, null));

        var resumed = await service.ResumeResultReadyAsync(new ResumeResultReadyDesignArtifactSessionRequest(
            run.Id,
            run.UserId,
            new DesignArtifactLifecycleExpectation(
                run.LifecycleVersion,
                run.WorkspaceRef!.BaseRevision,
                run.VersionBoundary!.BaseContentHash,
                "dead-worker",
                observedExpiry,
                Recovery: true)));

        Assert.Equal(RunStatuses.Queued, resumed.Status);
        Assert.Null(resumed.LeaseOwnerId);
        Assert.Null(resumed.LeaseExpiresAt);
        Assert.Equal("trusted/result-ready.json", resumed.WorkspaceResultAssetKey);
        Assert.Equal(DesignArtifactLifecycleEventTypes.Recovered, resumed.LifecycleEvents[^1].Type);
        Assert.True(resumed.LifecycleEvents[^1].Authoritative);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    [Trait("Category", TestCategories.Integration)]
    public async Task GenerationCancelEndpoint_ShouldShareCoordinatorForMapV1AndOpenDesignV2(bool currentContract)
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var events = new InMemoryRunEventStore();
        var lifecycle = new DesignArtifactLifecycleService(fixture.Db, events);
        DesignArtifactRun run;
        if (currentContract)
        {
            run = await lifecycle.CreateSessionAsync(Session(
                "cancel-generation-v2",
                DesignArtifactTypes.WebPage,
                DesignArtifactWorkspaceKinds.RemotePackage,
                "open-design"));
            await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
                item => item.Id == run.Id,
                Builders<DesignArtifactRun>.Update.Set(item => item.Status, RunStatuses.Queued));
        }
        else
        {
            run = new DesignArtifactRun
            {
                Id = "cancel-generation-v1",
                UserId = "owner-user",
                Status = RunStatuses.Queued,
                ArtifactType = DesignArtifactTypes.WebPage,
                Operation = DesignArtifactOperations.Generate,
                SourceSurface = DesignArtifactSourceSurfaces.WebHosting,
                Runtime = DesignArtifactRuntimes.MapGateway,
                Phase = "已排队",
            };
            await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        }
        var coordinator = new DesignArtifactCancellationCoordinator(fixture.Db, lifecycle);
        var controller = Controller(fixture, events, run.UserId, coordinator);

        Assert.IsType<OkObjectResult>(await controller.CancelRun(run.Id));
        Assert.IsType<OkObjectResult>(await controller.CancelRun(run.Id));

        var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Cancelled, persisted.Status);
        Assert.NotNull(persisted.CancelRequestedAt);
        Assert.NotNull(persisted.CancelledAt);
        Assert.Null(persisted.ProducedArtifactSiteId);
        Assert.Null(persisted.ProducedArtifactRevisionId);
        if (currentContract)
        {
            Assert.Equal(DesignArtifactLifecycleEventTypes.Cancelled, persisted.LifecycleEvents[^1].Type);
            Assert.True(persisted.LifecycleEvents[^1].Authoritative);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    [Trait("Category", TestCategories.Integration)]
    public async Task GenerationCancelEndpoint_ShouldRejectRunWithProducedArtifact(bool currentContract)
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var events = new InMemoryRunEventStore();
        var lifecycle = new DesignArtifactLifecycleService(fixture.Db, events);
        DesignArtifactRun run;
        if (currentContract)
        {
            run = await lifecycle.CreateSessionAsync(Session(
                "cancel-produced-v2",
                DesignArtifactTypes.WebPage,
                DesignArtifactWorkspaceKinds.RemotePackage,
                "open-design"));
            await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
                item => item.Id == run.Id,
                Builders<DesignArtifactRun>.Update.Set(item => item.Status, RunStatuses.Queued));
        }
        else
        {
            run = new DesignArtifactRun
            {
                Id = "cancel-produced-v1",
                UserId = "owner-user",
                Status = RunStatuses.Queued,
                ArtifactType = DesignArtifactTypes.WebPage,
                Operation = DesignArtifactOperations.Generate,
                SourceSurface = DesignArtifactSourceSurfaces.WebHosting,
                Runtime = DesignArtifactRuntimes.MapGateway,
            };
            await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        }
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == run.Id,
            Builders<DesignArtifactRun>.Update
                .Set(item => item.ProducedArtifactSiteId, "site-written")
                .Set(item => item.ProducedArtifactRevisionId, "revision-written"));
        var coordinator = new DesignArtifactCancellationCoordinator(fixture.Db, lifecycle);
        var controller = Controller(fixture, events, run.UserId, coordinator);

        Assert.IsType<ConflictObjectResult>(await controller.CancelRun(run.Id));

        var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Queued, persisted.Status);
        Assert.Null(persisted.CancelRequestedAt);
        Assert.Equal("revision-written", persisted.ProducedArtifactRevisionId);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ManifestReceiptMustMatchWorkspaceAndComputedHashes()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var run = await service.CreateSessionAsync(Session(
            "receipt-mismatch",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        var manifest = Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'a');
        var receipt = Receipt(run, manifest);
        receipt.WorkspaceId = "another-workspace";

        var error = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() =>
            service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
                run.Id,
                run.UserId,
                Expected(run),
                manifest,
                receipt)));

        Assert.Equal(DesignArtifactLifecycleErrorCodes.InvalidContract, error.Code);
        var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Null(persisted.Manifest);
        Assert.Null(persisted.ManifestValidation);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PlanDoneRequiresReceiptAndGenerateRejectsChangedPlanHash()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var plan = await service.CreateSessionAsync(Session(
            "strict-plan",
            DesignArtifactTypes.HtmlPpt,
            DesignArtifactWorkspaceKinds.AdapterOwned,
            "html-ppt",
            DesignArtifactOperations.Plan));
        await TrustHtmlPptPlanAsync(fixture, plan, 'd', 'e');
        var missing = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() =>
            service.CompleteAsync(new DesignArtifactLifecycleMutationRequest(
                plan.Id,
                plan.UserId,
                Expected(plan))));
        Assert.Equal(DesignArtifactLifecycleErrorCodes.InvalidContract, missing.Code);
        var completed = await service.CompleteAsync(new DesignArtifactLifecycleMutationRequest(
            plan.Id,
            plan.UserId,
            Expected(plan),
            PlanReceipt('d')));

        var request = Session(
            "generate-with-plan",
            DesignArtifactTypes.HtmlPpt,
            DesignArtifactWorkspaceKinds.AdapterOwned,
            "html-ppt") with
        {
            ParentPlanRunId = completed.Id,
            ParentPlanContentHash = new string('e', 64),
        };
        var changed = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() =>
            service.CreateSessionAsync(request));
        Assert.Equal(DesignArtifactLifecycleErrorCodes.InvalidContract, changed.Code);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task WebPageAndHtmlPpt_ShouldShareLifecycleShapeButKeepAdapterAndSecurityBoundaries()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var events = new InMemoryRunEventStore();
        var service = new DesignArtifactLifecycleService(fixture.Db, events);
        var web = await service.CreateSessionAsync(Session(
            "web-run",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        var ppt = await service.CreateSessionAsync(Session(
            "ppt-run",
            DesignArtifactTypes.HtmlPpt,
            DesignArtifactWorkspaceKinds.AdapterOwned,
            "html-ppt"));

        Assert.Equal(DesignArtifactContractVersions.Current, web.ContractVersion);
        Assert.Equal(web.ContractVersion, ppt.ContractVersion);
        Assert.Equal(web.LifecycleVersion, ppt.LifecycleVersion);
        Assert.NotEqual(web.WorkspaceRef!.Kind, ppt.WorkspaceRef!.Kind);
        Assert.NotEqual(web.WorkspaceRef.Adapter, ppt.WorkspaceRef.Adapter);
        var createFields = typeof(CreateDesignArtifactSessionRequest)
            .GetProperties()
            .Select(property => property.Name)
            .ToArray();
        Assert.DoesNotContain(createFields, field => field.Contains("BaseUrl", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(createFields, field => field.Contains("Model", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(createFields, field => field.Contains("Key", StringComparison.OrdinalIgnoreCase));

        var appended = await Task.WhenAll(Enumerable.Range(0, 12).Select(index =>
            service.AppendEventAsync(new AppendDesignArtifactEventRequest(
                web.Id,
                web.UserId,
                DesignArtifactLifecycleEventTypes.Phase,
                $"阶段 {index}",
                null))));
        Assert.Equal(Enumerable.Range(2, 12).Select(value => (long)value), appended.Select(item => item.Sequence).Order());

        var webManifest = Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'a');
        await TrustRemoteManifestAsync(fixture, web, webManifest);
        var pptManifest = ManifestForContent(
            DesignArtifactTypes.HtmlPpt,
            DesignArtifactSecurityProfiles.HtmlPptInteractive,
            "ppt-content");
        await TrustHtmlPptManifestAsync(fixture, ppt, "ppt-content");
        var webCommitted = await service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
            web.Id,
            web.UserId,
            Expected(web),
            webManifest,
            Receipt(web, webManifest)));
        var pptCommitted = await service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
            ppt.Id,
            ppt.UserId,
            Expected(ppt),
            pptManifest,
            Receipt(ppt, pptManifest)));

        Assert.Equal(RunStatuses.Committing, webCommitted.Status);
        Assert.Equal(RunStatuses.Committing, pptCommitted.Status);
        Assert.Equal(DesignArtifactSecurityProfiles.WebPageRestricted, webCommitted.Manifest!.SecurityProfile);
        Assert.Equal(DesignArtifactSecurityProfiles.HtmlPptInteractive, pptCommitted.Manifest!.SecurityProfile);
        Assert.Equal(webCommitted.VersionBoundary!.PackageHash, webCommitted.VersionBoundary.OutputContentHash);
        Assert.Equal(pptCommitted.VersionBoundary!.PackageHash, pptCommitted.VersionBoundary.OutputContentHash);
        Assert.Equal(new string('a', 64), webCommitted.VersionBoundary.EntryContentHash);
        Assert.Equal(pptManifest.Files[0].Sha256, pptCommitted.VersionBoundary.EntryContentHash);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task Manifest_ShouldRejectUnsafePathsDuplicatesBadHashesMissingEntryAndFileOverflow()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var invalidManifests = new List<LifecycleManifest>
        {
            Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'a', "/index.html"),
            Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'a', "../index.html"),
            new()
            {
                SchemaVersion = DesignArtifactContractVersions.ManifestV1,
                ArtifactType = DesignArtifactTypes.WebPage,
                EntryFile = "index.html",
                SecurityProfile = DesignArtifactSecurityProfiles.WebPageRestricted,
                Files =
                [
                    File("index.html", 'a'),
                    File("index.html", 'b'),
                ],
            },
            new()
            {
                SchemaVersion = DesignArtifactContractVersions.ManifestV1,
                ArtifactType = DesignArtifactTypes.WebPage,
                EntryFile = "index.html",
                SecurityProfile = DesignArtifactSecurityProfiles.WebPageRestricted,
                Files = [new LifecycleManifestFile { Path = "index.html", ByteLength = 1, Sha256 = "bad" }],
            },
            new()
            {
                SchemaVersion = DesignArtifactContractVersions.ManifestV1,
                ArtifactType = DesignArtifactTypes.WebPage,
                EntryFile = "index.html",
                SecurityProfile = DesignArtifactSecurityProfiles.WebPageRestricted,
                Files = [File("other.html", 'a')],
            },
            new()
            {
                SchemaVersion = DesignArtifactContractVersions.ManifestV1,
                ArtifactType = DesignArtifactTypes.WebPage,
                EntryFile = "index.html",
                SecurityProfile = DesignArtifactSecurityProfiles.WebPageRestricted,
                Files = Enumerable.Range(0, 257).Select(index => File($"file-{index}.html", 'a')).ToList(),
            },
            new()
            {
                SchemaVersion = DesignArtifactContractVersions.ManifestV1,
                ArtifactType = DesignArtifactTypes.WebPage,
                EntryFile = "index.html",
                SecurityProfile = DesignArtifactSecurityProfiles.WebPageRestricted,
                Files =
                [
                    new LifecycleManifestFile { Path = "index.html", ByteLength = 0, Sha256 = new string('a', 64), MediaType = "text/html" },
                ],
            },
            new()
            {
                SchemaVersion = DesignArtifactContractVersions.ManifestV1,
                ArtifactType = DesignArtifactTypes.WebPage,
                EntryFile = "index.html",
                SecurityProfile = DesignArtifactSecurityProfiles.WebPageRestricted,
                Files =
                [
                    new LifecycleManifestFile { Path = "index.html", ByteLength = 60L * 1024 * 1024, Sha256 = new string('a', 64), MediaType = "text/html" },
                    new LifecycleManifestFile { Path = "asset.bin", ByteLength = 60L * 1024 * 1024, Sha256 = new string('b', 64), MediaType = "application/octet-stream" },
                ],
            },
            Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.HtmlPptInteractive, 'a'),
        };

        for (var index = 0; index < invalidManifests.Count; index++)
        {
            var run = await service.CreateSessionAsync(Session(
                $"invalid-{index}",
                DesignArtifactTypes.WebPage,
                DesignArtifactWorkspaceKinds.RemotePackage,
                "open-design"));
            var error = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() =>
                service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
                    run.Id,
                    run.UserId,
                    Expected(run),
                    invalidManifests[index],
                    UnsafeReceipt(run, invalidManifests[index]))));
            Assert.Equal(DesignArtifactLifecycleErrorCodes.InvalidContract, error.Code);
            var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
            Assert.Equal(RunStatuses.Running, persisted.Status);
            Assert.Equal(1, persisted.LifecycleVersion);
            Assert.Null(persisted.Manifest);
        }
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task LifecycleMutations_ShouldUseCasAndBindPublishedRevisionContainingInternalManifest()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var run = await service.CreateSessionAsync(Session(
            "cas-run",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        const string publishedHtml = "<!doctype html><html><body>受信页面</body></html>";
        var validManifest = ManifestForContent(
            DesignArtifactTypes.WebPage,
            DesignArtifactSecurityProfiles.WebPageRestricted,
            publishedHtml);
        await TrustRemoteManifestAsync(fixture, run, validManifest);
        var commitRequest = new CommitDesignArtifactManifestRequest(
            run.Id,
            run.UserId,
            Expected(run),
            validManifest,
            Receipt(run, validManifest));

        var attempts = await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
        {
            try
            {
                await service.CommitManifestAsync(commitRequest);
                return true;
            }
            catch (DesignArtifactLifecycleException ex) when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict)
            {
                return false;
            }
        }));
        Assert.Single(attempts, value => value);

        var committed = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(2, committed.LifecycleVersion);
        await AssertConflict(() => service.CompleteAsync(new DesignArtifactLifecycleMutationRequest(
            committed.Id,
            committed.UserId,
            new DesignArtifactLifecycleExpectation(2, "older-revision", committed.VersionBoundary!.BaseContentHash))));

        var completed = await service.CompleteAsync(new DesignArtifactLifecycleMutationRequest(
            committed.Id,
            committed.UserId,
            Expected(committed)));
        Assert.Equal(RunStatuses.Done, completed.Status);
        Assert.Equal(3, completed.LifecycleVersion);
        var revision = await InsertPublishedRevisionAsync(fixture, completed, publishedHtml);
        Assert.Contains(
            revision.VerifiedFiles,
            file => file.Path == DesignArtifactPublicRevision.InternalManifestPath);
        var operationId = "publish-operation-1";
        var bound = await service.BindPublishedArtifactAsync(new BindPublishedDesignArtifactRequest(
            completed.Id,
            completed.UserId,
            Expected(completed),
            revision.SiteId,
            revision.Id,
            operationId,
            completed.VersionBoundary!.PackageHash!));
        Assert.Equal(revision.SiteId, bound.ArtifactSiteId);
        Assert.Equal(revision.Id, bound.ArtifactRevisionId);
        Assert.Equal(4, bound.LifecycleVersion);
        var replayedBinding = await service.BindPublishedArtifactAsync(new BindPublishedDesignArtifactRequest(
            bound.Id,
            bound.UserId,
            new DesignArtifactLifecycleExpectation(1, "stale", new string('0', 64)),
            revision.SiteId,
            revision.Id,
            operationId,
            completed.VersionBoundary.PackageHash!));
        Assert.Equal(4, replayedBinding.LifecycleVersion);
        await AssertConflict(() => service.BindPublishedArtifactAsync(new BindPublishedDesignArtifactRequest(
            bound.Id,
            bound.UserId,
            Expected(bound),
            revision.SiteId,
            revision.Id,
            "different-operation",
            completed.VersionBoundary.PackageHash!)));

        var uncommittedGenerate = await service.CreateSessionAsync(Session(
            "uncommitted-generate",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        await AssertConflict(() => service.CompleteAsync(new DesignArtifactLifecycleMutationRequest(
            uncommittedGenerate.Id,
            uncommittedGenerate.UserId,
            Expected(uncommittedGenerate))));

        var planning = await service.CreateSessionAsync(Session(
            "planning-run",
            DesignArtifactTypes.HtmlPpt,
            DesignArtifactWorkspaceKinds.AdapterOwned,
            "html-ppt",
            DesignArtifactOperations.Plan));
        await TrustHtmlPptPlanAsync(fixture, planning, 'd', 'e');
        var planned = await service.CompleteAsync(new DesignArtifactLifecycleMutationRequest(
            planning.Id,
            planning.UserId,
            Expected(planning),
            PlanReceipt('d')));
        Assert.Equal(RunStatuses.Done, planned.Status);
        Assert.Null(planned.Manifest);
        Assert.Null(planned.VersionBoundary!.OutputContentHash);
        await AssertConflict(() => service.BindPublishedArtifactAsync(new BindPublishedDesignArtifactRequest(
            planned.Id,
            planned.UserId,
            Expected(planned),
            "site-invalid",
            "version-invalid",
            "plan-publish",
            new string('d', 64))));
        var planningWithManifest = await service.CreateSessionAsync(Session(
            "planning-manifest-run",
            DesignArtifactTypes.HtmlPpt,
            DesignArtifactWorkspaceKinds.AdapterOwned,
            "html-ppt",
            DesignArtifactOperations.Plan));
        var planningManifestError = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() =>
            service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
                planningWithManifest.Id,
                planningWithManifest.UserId,
                Expected(planningWithManifest),
                Manifest(DesignArtifactTypes.HtmlPpt, DesignArtifactSecurityProfiles.HtmlPptInteractive, 'e'),
                Receipt(planningWithManifest, Manifest(DesignArtifactTypes.HtmlPpt, DesignArtifactSecurityProfiles.HtmlPptInteractive, 'e')))));
        Assert.Equal(DesignArtifactLifecycleErrorCodes.Conflict, planningManifestError.Code);

        var failureRun = await service.CreateSessionAsync(Session(
            "failure-run",
            DesignArtifactTypes.HtmlPpt,
            DesignArtifactWorkspaceKinds.AdapterOwned,
            "html-ppt"));
        var invalidFailure = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() =>
            service.FailAsync(new FailDesignArtifactSessionRequest(
                failureRun.Id,
                failureRun.UserId,
                Expected(failureRun),
                "Bearer secret https://provider.example")));
        Assert.Equal(DesignArtifactLifecycleErrorCodes.InvalidContract, invalidFailure.Code);
        var failed = await service.FailAsync(new FailDesignArtifactSessionRequest(
            failureRun.Id,
            failureRun.UserId,
            Expected(failureRun),
            "adapter_failed"));
        Assert.Equal(RunStatuses.Error, failed.Status);
        Assert.Equal("adapter_failed", failed.LifecycleFailureCode);
        Assert.DoesNotContain("provider", failed.ToJson(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishBinding_ShouldRejectForgedBytesAndEveryMismatchedOwnershipFence()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        const string publishedHtml = "<!doctype html><html><body>trusted-page</body></html>";
        var run = await service.CreateSessionAsync(Session(
            "strict-publish-receipt",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        var manifest = ManifestForContent(
            DesignArtifactTypes.WebPage,
            DesignArtifactSecurityProfiles.WebPageRestricted,
            publishedHtml);
        await TrustRemoteManifestAsync(fixture, run, manifest);
        var committed = await service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
            run.Id,
            run.UserId,
            Expected(run),
            manifest,
            Receipt(run, manifest)));
        var completed = await service.CompleteAsync(new DesignArtifactLifecycleMutationRequest(
            committed.Id,
            committed.UserId,
            Expected(committed)));
        var revision = await InsertPublishedRevisionAsync(fixture, completed, publishedHtml);
        var request = new BindPublishedDesignArtifactRequest(
            completed.Id,
            completed.UserId,
            Expected(completed),
            revision.SiteId,
            revision.Id,
            "strict-publish-operation",
            completed.VersionBoundary!.PackageHash!);

        var trustedBytes = revision.VerifiedFiles[0].Content;
        revision.VerifiedFiles[0].Content = Enumerable.Repeat((byte)'x', trustedBytes.Length).ToArray();
        await fixture.Db.HostedSiteRevisions.ReplaceOneAsync(item => item.Id == revision.Id, revision);
        await AssertInvalidContract(() => service.BindPublishedArtifactAsync(request));

        revision.VerifiedFiles[0].Content = trustedBytes;
        revision.SourceRunId = "another-run";
        await fixture.Db.HostedSiteRevisions.ReplaceOneAsync(item => item.Id == revision.Id, revision);
        await AssertInvalidContract(() => service.BindPublishedArtifactAsync(request));

        revision.SourceRunId = completed.Id;
        revision.Runtime = DesignArtifactRuntimes.MapGateway;
        await fixture.Db.HostedSiteRevisions.ReplaceOneAsync(item => item.Id == revision.Id, revision);
        await AssertInvalidContract(() => service.BindPublishedArtifactAsync(request));

        revision.Runtime = completed.Runtime;
        await fixture.Db.HostedSiteRevisions.ReplaceOneAsync(item => item.Id == revision.Id, revision);
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == completed.Id,
            Builders<DesignArtifactRun>.Update.Set(item => item.ProducedArtifactRevisionId, "another-revision"));
        await AssertInvalidContract(() => service.BindPublishedArtifactAsync(request));

        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == completed.Id,
            Builders<DesignArtifactRun>.Update.Set(item => item.ProducedArtifactRevisionId, revision.Id));
        var bound = await service.BindPublishedArtifactAsync(request);
        Assert.Equal(revision.SiteId, bound.ArtifactSiteId);
        Assert.Equal(revision.Id, bound.ArtifactRevisionId);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublicContractApi_ShouldReadLegacyV1AndNeverExposeKeysBodiesOrEventPayload()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var events = new InMemoryRunEventStore();
        var service = new DesignArtifactLifecycleService(fixture.Db, events);
        var current = await service.CreateSessionAsync(Session(
            "public-run",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        var publicManifest = Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'f');
        await TrustRemoteManifestAsync(fixture, current, publicManifest);
        current = await service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
            current.Id,
            current.UserId,
            Expected(current),
            publicManifest,
            Receipt(current, publicManifest)));
        current = await service.CompleteAsync(new DesignArtifactLifecycleMutationRequest(
            current.Id,
            current.UserId,
            Expected(current)));
        current.Instruction = "private instruction body";
        current.KnowledgeReferences =
        [
            new DesignKnowledgeSnapshot
            {
                EntryId = "entry-private",
                Title = "private title",
                Content = "private knowledge body",
                ContentHash = new string('d', 64),
            },
        ];
        current.WorkspaceInputAssetKey = "private/input-object-key";
        current.WorkspaceResultAssetKey = "private/result-object-key";
        await fixture.Db.DesignArtifactRuns.ReplaceOneAsync(item => item.Id == current.Id, current);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(new DesignArtifactRun
        {
            Id = "legacy-run",
            UserId = current.UserId,
            ArtifactType = DesignArtifactTypes.HtmlPpt,
            Instruction = "legacy private body",
            WorkspaceInputAssetKey = "legacy/private-key",
        });
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(new DesignArtifactRun
        {
            Id = "future-run",
            UserId = current.UserId,
            ContractVersion = 3,
        });

        var controller = Controller(fixture, events, current.UserId);
        var contract = Data(Assert.IsType<OkObjectResult>(await controller.GetContract(current.Id)));
        Assert.Equal(DesignArtifactContractVersions.Current, contract.GetProperty("contractVersion").GetInt32());
        Assert.True(contract.GetProperty("workspace").TryGetProperty("adapter", out _));
        Assert.True(contract.GetProperty("manifestPresent").GetBoolean());
        Assert.True(contract.GetProperty("manifestValidated").GetBoolean());
        Assert.True(contract.GetProperty("artifactReady").GetBoolean());
        Assert.Equal("index.html", contract.GetProperty("manifest").GetProperty("entryFile").GetString());
        Assert.Equal(new string('f', 64), contract.GetProperty("manifest").GetProperty("files")[0].GetProperty("sha256").GetString());
        Assert.False(contract.TryGetProperty("instruction", out _));

        var eventResult = Data(Assert.IsType<OkObjectResult>(await controller.GetContractEvents(current.Id)));
        Assert.Equal(3, eventResult.GetProperty("items").GetArrayLength());
        var serialized = JsonSerializer.Serialize(new { contract, eventResult }, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.DoesNotContain("private instruction body", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("private knowledge body", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("private event body", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("private-api-key", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("object-key", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("payload", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("baseUrl", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("apiKey", serialized, StringComparison.OrdinalIgnoreCase);

        var legacy = Data(Assert.IsType<OkObjectResult>(await controller.GetContract("legacy-run")));
        Assert.Equal(DesignArtifactContractVersions.Legacy, legacy.GetProperty("contractVersion").GetInt32());
        Assert.False(legacy.GetProperty("manifestPresent").GetBoolean());
        Assert.Equal(JsonValueKind.Null, legacy.GetProperty("manifest").ValueKind);
        Assert.IsType<ConflictObjectResult>(await controller.GetContract("future-run"));
        Assert.IsType<ConflictObjectResult>(await controller.GetContractEvents("legacy-run"));
        Assert.IsType<NotFoundObjectResult>(
            await Controller(fixture, events, "other-user").GetContract(current.Id));
    }

    [Theory]
    [InlineData(DesignArtifactRuntimes.MapGateway, false, "site-map")]
    [InlineData(DesignArtifactRuntimes.OpenDesign, true, "site-open-design")]
    [Trait("Category", TestCategories.Integration)]
    public async Task GenerationStream_ShouldExposeOneRecoverableContractForMapAndOpenDesign(
        string runtime,
        bool useProducedArtifact,
        string expectedSiteId)
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var events = new InMemoryRunEventStore();
        var run = new DesignArtifactRun
        {
            Id = $"stream-{runtime}",
            UserId = "owner-user",
            Runtime = runtime,
            ContractVersion = runtime == DesignArtifactRuntimes.OpenDesign
                ? DesignArtifactContractVersions.Current
                : DesignArtifactContractVersions.Legacy,
            Status = RunStatuses.Done,
            Progress = 100,
            Phase = "网页已生成",
            ArtifactSiteId = useProducedArtifact ? null : expectedSiteId,
            ArtifactRevisionId = useProducedArtifact ? null : "revision-map",
            ProducedArtifactSiteId = useProducedArtifact ? expectedSiteId : null,
            ProducedArtifactRevisionId = useProducedArtifact ? "revision-open-design" : null,
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        await events.AppendEventAsync(
            RunKinds.DesignArtifact,
            run.Id,
            "phase",
            new { progress = 40, message = "正在生成页面" });
        await events.AppendEventAsync(
            RunKinds.DesignArtifact,
            run.Id,
            "delta",
            new { text = "<main>实时内容</main>" });

        var controller = Controller(fixture, events, run.UserId);
        controller.Response.Body = new MemoryStream();
        await controller.StreamRun(run.Id, ct: CancellationToken.None);
        controller.Response.Body.Position = 0;
        using var reader = new StreamReader(controller.Response.Body);
        var stream = await reader.ReadToEndAsync();

        Assert.Contains("event: phase", stream, StringComparison.Ordinal);
        Assert.Contains("\"progress\":40", stream, StringComparison.Ordinal);
        Assert.Contains("event: delta", stream, StringComparison.Ordinal);
        Assert.Contains("实时内容", stream, StringComparison.Ordinal);
        Assert.Contains("event: done", stream, StringComparison.Ordinal);
        Assert.Contains($"\"siteId\":\"{expectedSiteId}\"", stream, StringComparison.Ordinal);
    }

    private static CreateDesignArtifactSessionRequest Session(
        string runId,
        string artifactType,
        string workspaceKind,
        string adapter,
        string operation = DesignArtifactOperations.Generate) => new(
        runId,
        "owner-user",
        artifactType,
        operation,
        artifactType == DesignArtifactTypes.HtmlPpt
            ? DesignArtifactSourceSurfaces.HtmlPpt
            : DesignArtifactSourceSurfaces.WebHosting,
        artifactType == DesignArtifactTypes.HtmlPpt
            ? DesignArtifactRuntimes.HtmlPptPipeline
            : DesignArtifactRuntimes.OpenDesign,
        new DesignArtifactWorkspaceRef
        {
            WorkspaceId = $"workspace-{runId}",
            Kind = workspaceKind,
            BaseRevision = "base-revision",
            Adapter = adapter,
        },
        new DesignArtifactVersionBoundary
        {
            BaseArtifactId = "base-artifact",
            BaseVersion = "base-version",
            BaseContentHash = new string('c', 64),
        },
        Capability(artifactType, workspaceKind, adapter));

    private static DesignArtifactCapabilitySnapshot Capability(
        string artifactType,
        string workspaceKind,
        string adapter) => new()
    {
        CapabilityId = $"{adapter}.v1",
        ArtifactType = artifactType,
        Runtime = artifactType == DesignArtifactTypes.HtmlPpt
            ? DesignArtifactRuntimes.HtmlPptPipeline
            : DesignArtifactRuntimes.OpenDesign,
        Adapter = adapter,
        WorkspaceKind = workspaceKind,
        SecurityProfile = artifactType == DesignArtifactTypes.HtmlPpt
            ? DesignArtifactSecurityProfiles.HtmlPptInteractive
            : DesignArtifactSecurityProfiles.WebPageRestricted,
        Operations =
        [
            DesignArtifactOperations.Plan,
            DesignArtifactOperations.Generate,
            DesignArtifactOperations.Edit,
        ],
        SourceSurfaces =
        [
            DesignArtifactSourceSurfaces.WebHosting,
            DesignArtifactSourceSurfaces.KnowledgeBase,
            DesignArtifactSourceSurfaces.HtmlPpt,
        ],
    };

    private static DesignArtifactLifecycleExpectation Expected(DesignArtifactRun run) => new(
        run.LifecycleVersion,
        run.WorkspaceRef!.BaseRevision,
        run.VersionBoundary!.BaseContentHash);

    private static LifecycleManifest Manifest(
        string artifactType,
        string securityProfile,
        char hash,
        string path = "index.html") => new()
    {
        SchemaVersion = DesignArtifactContractVersions.ManifestV1,
        ArtifactType = artifactType,
        EntryFile = path,
        SecurityProfile = securityProfile,
        Files = [File(path, hash)],
    };

    private static LifecycleManifest ManifestForContent(
        string artifactType,
        string securityProfile,
        string content)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(content);
        return new LifecycleManifest
        {
            SchemaVersion = DesignArtifactContractVersions.ManifestV1,
            ArtifactType = artifactType,
            EntryFile = "index.html",
            SecurityProfile = securityProfile,
            Files =
            [
                new LifecycleManifestFile
                {
                    Path = "index.html",
                    ByteLength = bytes.LongLength,
                    Sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(),
                    MediaType = "text/html",
                },
            ],
        };
    }

    private static LifecycleManifestFile File(string path, char hash) => new()
    {
        Path = path,
        ByteLength = 128,
        Sha256 = new string(hash, 64),
        MediaType = "text/html",
    };

    private static DesignArtifactManifestValidationReceipt Receipt(
        DesignArtifactRun run,
        LifecycleManifest manifest)
    {
        var hashes = DesignArtifactLifecycleService.ComputeManifestHashes(manifest);
        return new DesignArtifactManifestValidationReceipt
        {
            Validator = run.WorkspaceRef!.Adapter,
            WorkspaceId = run.WorkspaceRef!.WorkspaceId,
            SecurityPolicyVersion = "test-policy.v1",
            EntryContentHash = hashes.EntryContentHash,
            CanonicalManifestHash = hashes.CanonicalManifestHash,
            PackageHash = hashes.PackageHash,
            SourcePackageHash = run.WorkspaceResultSha256,
            SourceManifestHash = run.WorkspaceManifestSha256,
            TotalBytes = hashes.TotalBytes,
            ValidatedAt = DateTime.UtcNow,
        };
    }

    private static DesignArtifactManifestValidationReceipt UnsafeReceipt(
        DesignArtifactRun run,
        LifecycleManifest manifest)
    {
        try
        {
            return Receipt(run, manifest);
        }
        catch
        {
            return new DesignArtifactManifestValidationReceipt
            {
                Validator = "test-validator",
                WorkspaceId = run.WorkspaceRef!.WorkspaceId,
                SecurityPolicyVersion = "test-policy.v1",
                EntryContentHash = new string('a', 64),
                CanonicalManifestHash = new string('b', 64),
                PackageHash = new string('c', 64),
                TotalBytes = 128,
                ValidatedAt = DateTime.UtcNow,
            };
        }
    }

    private static DesignArtifactPlanReceipt PlanReceipt(char hash) => new()
    {
        StorageReference = "test-plan-output",
        ContentHash = new string(hash, 64),
        InputHash = new string('e', 64),
    };

    private static async Task TrustRemoteManifestAsync(
        LifecycleMongoFixture fixture,
        DesignArtifactRun run,
        LifecycleManifest manifest)
    {
        run.WorkspaceResultAssetKey = $"trusted/{run.Id}";
        run.WorkspaceResultSha256 = new string('7', 64);
        run.WorkspaceManifestSha256 = new string('8', 64);
        await fixture.Db.DesignArtifactRuns.ReplaceOneAsync(item => item.Id == run.Id, run);
    }

    private static async Task TrustHtmlPptManifestAsync(
        LifecycleMongoFixture fixture,
        DesignArtifactRun run,
        string html)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(html);
        await fixture.Db.MdToPptRuns.InsertOneAsync(new MdToPptRun
        {
            Id = run.Id,
            UserId = run.UserId,
            Status = "done",
            Op = "convert",
            ArtifactContractVersion = DesignArtifactContractVersions.Current,
            Html = html,
            HtmlHash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(),
        });
    }

    private static async Task TrustHtmlPptPlanAsync(
        LifecycleMongoFixture fixture,
        DesignArtifactRun run,
        char contentHash,
        char inputHash)
    {
        await fixture.Db.MdToPptRuns.InsertOneAsync(new MdToPptRun
        {
            Id = run.Id,
            UserId = run.UserId,
            Status = "done",
            Op = "outline",
            ArtifactContractVersion = DesignArtifactContractVersions.Current,
            OutlineHash = new string(contentHash, 64),
            UserSuppliedContentHash = new string(inputHash, 64),
        });
    }

    private static async Task<HostedSiteRevision> InsertPublishedRevisionAsync(
        LifecycleMongoFixture fixture,
        DesignArtifactRun run,
        string html)
    {
        var site = new HostedSite
        {
            Id = "site-current",
            OwnerUserId = run.UserId,
            ContentVersion = DateTime.UtcNow,
        };
        var revision = new HostedSiteRevision
        {
            Id = "version-current",
            SiteId = site.Id,
            CreatedByUserId = run.UserId,
            Status = HostedSiteRevisionStatuses.Published,
            SourceRunId = run.Id,
            Runtime = run.Runtime,
            Html = html,
        };
        revision.VerifiedFiles = run.Manifest!.Files.Select(file => new HostedSiteRevisionFile
        {
            Path = file.Path,
            Content = System.Text.Encoding.UTF8.GetBytes(html),
            Sha256 = file.Sha256,
            MimeType = file.MediaType,
        }).ToList();
        var internalManifestBytes = System.Text.Encoding.UTF8.GetBytes("{\"schemaVersion\":\"test\"}");
        revision.VerifiedFiles.Add(new HostedSiteRevisionFile
        {
            Path = DesignArtifactPublicRevision.InternalManifestPath,
            Content = internalManifestBytes,
            Sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(internalManifestBytes)).ToLowerInvariant(),
            MimeType = "application/json",
        });
        run.ProducedArtifactSiteId = site.Id;
        run.ProducedArtifactRevisionId = revision.Id;
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == run.Id,
            Builders<DesignArtifactRun>.Update
                .Set(item => item.ProducedArtifactSiteId, site.Id)
                .Set(item => item.ProducedArtifactRevisionId, revision.Id));
        await fixture.Db.HostedSites.InsertOneAsync(site);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        return revision;
    }

    private static async Task AssertInvalidContract(Func<Task> action)
    {
        var error = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(action);
        Assert.Equal(DesignArtifactLifecycleErrorCodes.InvalidContract, error.Code);
    }

    private static async Task AssertConflict(Func<Task> action)
    {
        var error = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(action);
        Assert.Equal(DesignArtifactLifecycleErrorCodes.Conflict, error.Code);
    }

    private static DesignArtifactsController Controller(
        LifecycleMongoFixture fixture,
        IRunEventStore events,
        string userId,
        IDesignArtifactCancellationCoordinator? cancellation = null)
    {
        var controller = new DesignArtifactsController(
            fixture.Db,
            events,
            Mock.Of<IRunQueue>(),
            Mock.Of<IDesignArtifactProviderCatalog>(),
            Mock.Of<IDesignKnowledgeSnapshotResolver>(),
            new LlmGatewayDataContext(fixture.ConnectionString, fixture.GatewayDatabaseName),
            cancellation ?? Mock.Of<IDesignArtifactCancellationCoordinator>(), new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build());
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", userId)], "test")),
            },
        };
        return controller;
    }

    private static JsonElement Data(OkObjectResult result)
        => JsonSerializer.SerializeToElement(result.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            .GetProperty("data");

    private sealed class LifecycleMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private LifecycleMongoFixture(MongoClient client, string connectionString, string suffix)
        {
            _client = client;
            ConnectionString = connectionString;
            _databaseName = $"design_lifecycle_{suffix}";
            GatewayDatabaseName = $"design_lifecycle_gw_{suffix}";
            Db = new MongoDbContext(connectionString, _databaseName);
        }

        internal string ConnectionString { get; }
        internal string GatewayDatabaseName { get; }
        internal MongoDbContext Db { get; }

        internal static async Task<LifecycleMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new LifecycleMongoFixture(client, connectionString, Guid.NewGuid().ToString("N"));
        }

        public async ValueTask DisposeAsync()
        {
            await _client.DropDatabaseAsync(_databaseName);
            await _client.DropDatabaseAsync(GatewayDatabaseName);
        }
    }
}
