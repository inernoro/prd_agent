using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
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
    [Trait("Category", TestCategories.Integration)]
    public async Task PresentationResultWithoutProducedIdentity_MustResumeSavingBeforeReportingDone()
    {
        await using var fixture = await Fixture.CreateAsync();
        var setup = await StartedAdapterAsync(fixture, DesignArtifactOperations.Generate, DesignArtifactTypes.HtmlPpt);
        var html = HostedSiteRevisionRules.HardenVerifiedPackageHtml(Html, Files().Select(file => file.Path).ToArray());
        var files = Files().Select(file => file.Path == "index.html"
            ? File(file.Path, Encoding.UTF8.GetBytes(html), file.MediaType) : file).ToArray();
        await StoreBrokerFactsAsync(fixture.Db, setup.Run.Id);
        await setup.Adapter.CommitManifestAsync(setup.Run.Id, files, ActiveLease(setup.Run));
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(item => item.Id == setup.Run.Id,
            Builders<DesignArtifactRun>.Update.Set(item => item.LeaseExpiresAt, DateTime.UtcNow.AddSeconds(-1)));
        await fixture.Db.MdToPptRuns.InsertOneAsync(new MdToPptRun
        { Id = setup.Run.Id, UserId = setup.Run.UserId, Status = "running", Op = "convert" });
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        broker.Setup(item => item.ReadResultAsync(setup.Run.Id, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ParsedDesignWorkspaceResult(html, files));
        var events = new InMemoryRunEventStore();
        var lifecycle = new DesignArtifactLifecycleService(fixture.Db, events);
        var adapter = new WebPageDesignArtifactLifecycleAdapter(fixture.Db, lifecycle, broker.Object,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<WebPageDesignArtifactLifecycleAdapter>.Instance);
        var queue = new InMemoryRunQueue();

        await adapter.RecoverPendingAsync();
        var compatibility = await fixture.Db.MdToPptRuns.Find(item => item.Id == setup.Run.Id).SingleAsync();
        Assert.Equal("running", compatibility.Status);
        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(fixture.Db, queue, events, DateTime.UtcNow,
            CancellationToken.None, publicLifecycle: adapter, lifecycle: lifecycle);
        var recovered = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == setup.Run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Queued, recovered.Status);
        Assert.Null(recovered.ProducedArtifactSiteId);
        Assert.Null(recovered.ProducedArtifactRevisionId);
        Assert.Equal(setup.Run.Id, await queue.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Equal(0, await fixture.Db.HostedSiteRevisions.CountDocumentsAsync(_ => true));

        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        var baseline = DateTime.UtcNow;
        var site = new HostedSite { Id = "recovered-ppt", OwnerUserId = setup.Run.UserId,
            SourceRef = setup.Run.Id, SourceType = "design-agent", ContentVersion = baseline };
        sites.Setup(item => item.PrepareTrustedPresentationHtmlForHosting(It.IsAny<byte[]>(), "index.html"))
            .Returns((byte[] bytes, string _) => bytes);
        sites.Setup(item => item.PrepareHtmlForHosting(It.IsAny<byte[]>(), "index.html"))
            .Returns((byte[] bytes, string _) => bytes);
        sites.Setup(item => item.CreateFromVerifiedFilesAsync(setup.Run.UserId, It.IsAny<IReadOnlyList<HostedSiteVerifiedFile>>(),
                It.IsAny<string?>(), It.IsAny<string?>(), "design-agent", setup.Run.Id, It.IsAny<List<string>?>(), null,
                It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(async (string _, IReadOnlyList<HostedSiteVerifiedFile> files, string? _, string? _, string _, string _,
                List<string>? _, string? _, string _, CancellationToken _) =>
            {
                site.Files = files.Select(file => new HostedSiteFile { Path = file.Path, CosKey = "synthetic/" + file.Path }).ToList();
                await fixture.Db.HostedSites.InsertOneAsync(site);
                return site;
            });
        sites.Setup(item => item.GetEditableEntryHtmlAsync(site.Id, setup.Run.UserId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(site, html, baseline));
        revisions.Setup(item => item.EnsureGeneratedVerifiedSnapshotAsync(site.Id, setup.Run.UserId,
                It.IsAny<HostedSiteEditableEntry>(), It.IsAny<IReadOnlyList<HostedSiteVerifiedFile>>(),
                DesignArtifactRuntimes.OpenDesign, setup.Run.Id, It.IsAny<IReadOnlyCollection<string>>(), It.IsAny<CancellationToken>()))
            .Returns(async (string _, string _, HostedSiteEditableEntry _, IReadOnlyList<HostedSiteVerifiedFile> files,
                string _, string _, IReadOnlyCollection<string> _, CancellationToken _) =>
            {
                var revision = new HostedSiteRevision { Id = "recovered-ppt-revision", SiteId = site.Id,
                    CreatedByUserId = setup.Run.UserId, SourceRunId = setup.Run.Id, Runtime = DesignArtifactRuntimes.OpenDesign,
                    Status = HostedSiteRevisionStatuses.Published, Html = html, PublishedContentVersion = baseline,
                    VerifiedFiles = files.Select(file => new HostedSiteRevisionFile { Path = file.Path, Content = file.Content,
                        Sha256 = file.Sha256, MimeType = file.MimeType }).ToList() };
                await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
                return revision;
            });
        var http = new Mock<IHttpClientFactory>(MockBehavior.Strict);
        var executor = new OpenDesignServiceArtifactExecutor(http.Object, broker.Object,
            Mock.Of<IDesignArtifactGatewayGrantService>(MockBehavior.Strict), new ConfigurationBuilder().Build(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<OpenDesignServiceArtifactExecutor>.Instance);
        using var services = new ServiceCollection().AddSingleton(fixture.Db).AddSingleton(sites.Object)
            .AddSingleton(revisions.Object).AddSingleton<IDesignArtifactLifecycleService>(lifecycle)
            .AddSingleton<IWebPageDesignArtifactLifecycleAdapter>(adapter)
            .AddSingleton(Mock.Of<IDesignKnowledgeSnapshotResolver>()).AddSingleton(Mock.Of<IActivityActionRecorder>())
            .AddSingleton<IDesignArtifactExecutor>(executor).BuildServiceProvider();
        var logger = new Mock<Microsoft.Extensions.Logging.ILogger<HostedSiteEditRunWorker>>();
        using var worker = new HostedSiteEditRunWorker(services.GetRequiredService<IServiceScopeFactory>(), queue, events, logger.Object);
        await worker.ProcessAsync(setup.Run.Id, CancellationToken.None);
        var done = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == setup.Run.Id).SingleAsync();
        Assert.True(WebPageDesignArtifactLifecycleAdapter.IsCompletedPresentation(done), $"status={done.Status};error={done.Error};failure={done.LifecycleFailureCode};produced={done.ProducedArtifactSiteId}/{done.ProducedArtifactRevisionId};diagnostic={string.Join(" | ", logger.Invocations.Select(call => call.Arguments.Count > 3 ? call.Arguments[3]?.ToString() : null))}");
        Assert.Equal("recovered-ppt-revision", done.ProducedArtifactRevisionId);
        Assert.Equal("done", (await fixture.Db.MdToPptRuns.Find(item => item.Id == setup.Run.Id).SingleAsync()).Status);
        Assert.Equal(Files().Count, (await fixture.Db.HostedSiteRevisions.Find(item => item.Id == done.ProducedArtifactRevisionId).SingleAsync()).VerifiedFiles.Count);
        Assert.Equal(0, await adapter.RecoverPendingAsync());
        Assert.Equal(1, await fixture.Db.HostedSites.CountDocumentsAsync(_ => true));
        http.VerifyNoOtherCalls(); // 已提交包的恢复路径没有任何 HTTP/模型发送。
    }

    [Theory]
    [InlineData("complete")]
    [InlineData("bind")]
    [Trait("Category", TestCategories.Integration)]
    public async Task PresentationCompletionFailure_KeepsCompatibilityPendingAndRecoversTheSameWholePackage(string failingStage)
    {
        await using var fixture = await Fixture.CreateAsync();
        var setup = await StartedAdapterAsync(fixture, DesignArtifactOperations.Generate, DesignArtifactTypes.HtmlPpt);
        await StoreBrokerFactsAsync(fixture.Db, setup.Run.Id);
        await setup.Adapter.CommitManifestAsync(setup.Run.Id, Files(), ActiveLease(setup.Run));
        var baseline = new DateTime(2026, 11, 4, 1, 2, 3, DateTimeKind.Utc);
        var artifact = new PersistedDesignArtifact("ppt-site", "ppt-revision", HostedSiteRevisionStatuses.Published, null, "Deck");
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(item => item.Id == setup.Run.Id,
            Builders<DesignArtifactRun>.Update.Set(item => item.ProducedArtifactSiteId, artifact.SiteId)
                .Set(item => item.ProducedArtifactRevisionId, artifact.RevisionId));
        // 两边各有超过批次上限的不合格记录：不能先截任一集合再做另一侧判定。
        await fixture.Db.MdToPptRuns.InsertManyAsync(Enumerable.Range(0, 100).Select(index => new MdToPptRun
        { Id = $"unmanaged-{index}", UserId = setup.Run.UserId, Runtime = DesignArtifactRuntimes.OpenDesign, Status = "running" }));
        await fixture.Db.DesignArtifactRuns.InsertManyAsync(Enumerable.Range(0, 100).Select(index => new DesignArtifactRun
        { Id = $"settled-{index}", UserId = setup.Run.UserId, DeploymentSlug = DeploymentScope.Current,
            Runtime = DesignArtifactRuntimes.OpenDesign, ArtifactType = DesignArtifactTypes.HtmlPpt, Status = RunStatuses.Done,
            UpdatedAt = DateTime.UtcNow.AddDays(-1) }));
        await fixture.Db.MdToPptRuns.InsertManyAsync(Enumerable.Range(0, 100).Select(index => new MdToPptRun
        { Id = $"settled-{index}", UserId = setup.Run.UserId, Runtime = DesignArtifactRuntimes.OpenDesign, Status = "done" }));
        await fixture.Db.MdToPptRuns.InsertOneAsync(new MdToPptRun
        { Id = setup.Run.Id, UserId = setup.Run.UserId, Runtime = DesignArtifactRuntimes.OpenDesign, Status = "running", Op = "convert" });
        await fixture.Db.HostedSites.InsertOneAsync(new HostedSite
        { Id = artifact.SiteId, OwnerUserId = setup.Run.UserId, SourceRef = setup.Run.Id, ContentVersion = baseline });
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(new HostedSiteRevision
        {
            Id = artifact.RevisionId, SiteId = artifact.SiteId, CreatedByUserId = setup.Run.UserId,
            SourceRunId = setup.Run.Id, Runtime = DesignArtifactRuntimes.OpenDesign,
            Status = HostedSiteRevisionStatuses.Published, PublishedContentVersion = baseline,
            Html = Html, VerifiedFiles = Files().Select(ToRevisionFile).ToList(),
        });
        var failing = new Mock<IWebPageDesignArtifactLifecycleAdapter>(MockBehavior.Strict);
        failing.Setup(item => item.CompleteAsync(setup.Run.Id, It.IsAny<DesignArtifactLifecycleLeaseAuthority>(), It.IsAny<CancellationToken>()))
            .Returns((string id, DesignArtifactLifecycleLeaseAuthority lease, CancellationToken ct) =>
                failingStage == "complete" ? Task.FromException(new IOException("synthetic completion failure")) : setup.Adapter.CompleteAsync(id, lease, ct));
        failing.Setup(item => item.BindPublishedAsync(setup.Run.Id, artifact.SiteId, artifact.RevisionId, It.IsAny<CancellationToken>()))
            .ThrowsAsync(new IOException("synthetic binding failure"));

        await Assert.ThrowsAsync<DesignArtifactRunLeaseLostException>(() => HostedSiteEditRunWorker.CompletePresentationRecordAsync(
            fixture.Db, setup.Run, ActiveLease(setup.Run), failing.Object, Html, artifact, CancellationToken.None));
        Assert.Equal("running", (await fixture.Db.MdToPptRuns.Find(item => item.Id == setup.Run.Id).SingleAsync()).Status);
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(item => item.Id == setup.Run.Id,
            Builders<DesignArtifactRun>.Update.Set(item => item.LeaseExpiresAt, DateTime.UtcNow.AddSeconds(-1)));
        Assert.Equal(1, await setup.Adapter.RecoverPendingAsync());
        var completed = await fixture.Db.MdToPptRuns.Find(item => item.Id == setup.Run.Id).SingleAsync();
        var publicRun = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == setup.Run.Id).SingleAsync();
        Assert.Equal("done", completed.Status);
        Assert.Equal(Html, completed.Html);
        Assert.Equal(artifact.RevisionId, completed.PublishedVersionId);
        Assert.True(WebPageDesignArtifactLifecycleAdapter.IsCompletedPresentation(publicRun));
        Assert.Equal(1, await fixture.Db.HostedSiteRevisions.CountDocumentsAsync(_ => true));
        Assert.Equal(0, await setup.Adapter.RecoverPendingAsync());
    }

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
        Assert.Equal(siteId, persisted.ProducedArtifactSiteId);
        Assert.Equal(revisionId, persisted.ProducedArtifactRevisionId);
        Assert.Equal(DesignArtifactLifecycleEventTypes.Published, persisted.LifecycleEvents[^1].Type);
        Assert.True(persisted.LifecycleEvents[^1].Authoritative);
    }

    private const string Html = "<!doctype html><html><body><h1>可信页面</h1></body></html>";

    private static async Task<(DesignArtifactRun Run, WebPageDesignArtifactLifecycleAdapter Adapter)> StartedAdapterAsync(
        Fixture fixture,
        string operation,
        string artifactType = DesignArtifactTypes.WebPage)
    {
        var run = NewRun(operation);
        run.ArtifactType = artifactType;
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
