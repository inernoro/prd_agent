using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
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

public sealed class HtmlPptDesignArtifactAdapterTests
{
    [Fact]
    public void HostedPresentationNavigationBridge_ShouldDriveTheRealDeckAfterAnExplicitParentHandshake()
    {
        const string source = "<!doctype html><html><body><div class=\"reveal\"><div class=\"slides\"><section>第一页</section><section>第二页</section></div></div></body></html>";

        var hosted = Encoding.UTF8.GetString(HostedSiteService.RewritePublishedEntryHtml(
            Encoding.UTF8.GetBytes(source),
            "index.html"));

        Assert.Contains("event.source !== window.parent", hosted, StringComparison.Ordinal);
        Assert.Contains("data.type === 'map-ppt-init'", hosted, StringComparison.Ordinal);
        Assert.Contains("data.type === 'map-ppt-nav'", hosted, StringComparison.Ordinal);
        Assert.Contains("data.type === 'map-ppt-goto'", hosted, StringComparison.Ordinal);
        Assert.Contains("window.Reveal.next()", hosted, StringComparison.Ordinal);
        Assert.Contains("window.Reveal.slide(target)", hosted, StringComparison.Ordinal);
        Assert.Contains("bridgePost('map-ppt-slide')", hosted, StringComparison.Ordinal);
        Assert.Contains("<section>第一页</section><section>第二页</section>", hosted, StringComparison.Ordinal);
    }

    [Fact]
    public void AdapterContract_ShouldNotAcceptRuntimeAuthorityConfiguration()
    {
        var constructorFields = typeof(HtmlPptDesignArtifactAdapter)
            .GetConstructors()
            .Single()
            .GetParameters()
            .Select(parameter => parameter.ParameterType.Name)
            .ToArray();
        Assert.DoesNotContain(constructorFields, field => field.Contains("Configuration", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(constructorFields, field => field.Contains("Gateway", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(constructorFields, field => field.Contains("Model", StringComparison.OrdinalIgnoreCase));

        var root = FindRepositoryRoot();
        var controller = File.ReadAllText(Path.Combine(
            root,
            "prd-api",
            "src",
            "PrdAgent.Api",
            "Controllers",
            "Api",
            "MdToPptController.cs"));
        Assert.Contains("RunId: auditRunId", controller, StringComparison.Ordinal);
        Assert.Contains("SessionId: auditRunId", controller, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PlanAndHtmlArtifact_ShouldUseSameIdAndExactUtf8Manifest()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        var events = new InMemoryRunEventStore();
        var adapter = Adapter(fixture, events);

        var plan = Run("plan-run", "outline", "running", string.Empty, null);
        await fixture.Db.MdToPptRuns.InsertOneAsync(plan);
        await adapter.BeginAsync(plan);
        plan.Status = "done";
        plan.OutlineJson = "{\"outline\":[]}";
        plan.OutlineHash = new string('a', 64);
        plan.UserSuppliedContentHash = new string('b', 64);
        plan.UpdatedAt = DateTime.UtcNow;
        await fixture.Db.MdToPptRuns.ReplaceOneAsync(item => item.Id == plan.Id, plan);
        await adapter.CompletePlanAsync(plan);

        var plannedPublic = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == plan.Id).SingleAsync();
        Assert.Equal(plan.Id, plannedPublic.Id);
        Assert.Equal(DesignArtifactOperations.Plan, plannedPublic.Operation);
        Assert.Equal(DesignArtifactWorkspaceKinds.AdapterOwned, plannedPublic.WorkspaceRef!.Kind);
        Assert.Equal(HtmlPptDesignArtifactAdapter.AdapterId, plannedPublic.WorkspaceRef.Adapter);
        Assert.Equal(RunStatuses.Done, plannedPublic.Status);
        Assert.Null(plannedPublic.Manifest);
        Assert.Equal(plan.OutlineHash, plannedPublic.PlanReceipt!.ContentHash);

        const string html = "<!doctype html><html lang=\"zh\"><head></head><body>中文 PPT</body></html>";
        var htmlHash = MdToPptController.ComputeHtmlHash(html);
        var artifact = Run("artifact-run", "convert", "running", html, htmlHash);
        await fixture.Db.MdToPptRuns.InsertOneAsync(artifact);
        await adapter.BeginAsync(artifact);
        artifact.Status = "done";
        artifact.UpdatedAt = DateTime.UtcNow;
        await fixture.Db.MdToPptRuns.ReplaceOneAsync(item => item.Id == artifact.Id, artifact);
        await adapter.CommitAndCompleteAsync(artifact);

        var publicArtifact = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == artifact.Id).SingleAsync();
        Assert.Equal(RunStatuses.Done, publicArtifact.Status);
        Assert.Equal(DesignArtifactOperations.Generate, publicArtifact.Operation);
        Assert.Equal(htmlHash, publicArtifact.VersionBoundary!.EntryContentHash);
        Assert.Equal(publicArtifact.VersionBoundary.PackageHash, publicArtifact.VersionBoundary.OutputContentHash);
        var manifestFile = Assert.Single(publicArtifact.Manifest!.Files);
        Assert.Equal("index.html", publicArtifact.Manifest.EntryFile);
        Assert.Equal("index.html", manifestFile.Path);
        Assert.Equal(Encoding.UTF8.GetByteCount(html), manifestFile.ByteLength);
        Assert.Equal(htmlHash, manifestFile.Sha256);
        Assert.Equal("text/html", manifestFile.MediaType);
        Assert.NotNull(publicArtifact.ManifestValidation);

        var records = publicArtifact.LifecycleEvents;
        Assert.Contains(records, record => record.Type == DesignArtifactLifecycleEventTypes.Run);
        Assert.Contains(records, record => record.Type == DesignArtifactLifecycleEventTypes.Manifest);
        Assert.Contains(records, record => record.Type == DesignArtifactLifecycleEventTypes.Done);
        Assert.Equal(records.Select(record => record.Sequence), Enumerable.Range(1, records.Count).Select(value => (long)value));
        var serializedEvents = System.Text.Json.JsonSerializer.Serialize(records);
        Assert.DoesNotContain(html, serializedEvents, StringComparison.Ordinal);
        Assert.DoesNotContain("baseUrl", serializedEvents, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("model", serializedEvents, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("connection", serializedEvents, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task Recovery_ShouldCloseDoneFailureAndPublishBindingWindows()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        var events = new InMemoryRunEventStore();
        var adapter = Adapter(fixture, events);

        const string html = "<!doctype html><html><head></head><body>recover</body></html>";
        var hash = MdToPptController.ComputeHtmlHash(html);
        var done = Run("recover-done", "patch", "running", html, hash, "parent-run", new string('a', 64));
        await fixture.Db.MdToPptRuns.InsertOneAsync(done);
        await adapter.BeginAsync(done);
        done.Status = "done";
        done.ArtifactContractSynchronizedAt = null;
        done.UpdatedAt = DateTime.UtcNow;
        await fixture.Db.MdToPptRuns.ReplaceOneAsync(item => item.Id == done.Id, done);

        Assert.Equal(1, await adapter.RecoverPendingAsync());
        var recoveredDone = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == done.Id).SingleAsync();
        Assert.Equal(RunStatuses.Done, recoveredDone.Status);
        Assert.Equal(hash, recoveredDone.Manifest!.Files.Single().Sha256);

        var site = new HostedSite
        {
            Id = "owned-site",
            OwnerUserId = done.UserId,
            Title = "Recovered PPT",
            SiteUrl = "https://site.invalid/index.html",
            ContentVersion = new DateTime(2026, 9, 8, 1, 2, 3, DateTimeKind.Utc),
            PublishedRevisionId = "baseline-owned-site",
        };
        var revision = new HostedSiteRevision
        {
            Id = site.PublishedRevisionId,
            SiteId = site.Id,
            CreatedByUserId = done.UserId,
            Status = HostedSiteRevisionStatuses.Published,
            Source = HostedSiteRevisionSources.Baseline,
            Runtime = DesignArtifactRuntimes.HtmlPptPipeline,
            SourceRunId = done.Id,
            Html = html,
            BasedOnContentVersion = site.ContentVersion,
            PublishedContentVersion = site.ContentVersion,
            CreatedAt = site.ContentVersion,
            PublishedAt = site.ContentVersion,
        };
        await fixture.Db.HostedSites.InsertOneAsync(site);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        done.PublishedSiteId = site.Id;
        done.PublishedHtmlHash = hash;
        done.PublishedVersionId = revision.Id;
        done.ArtifactContractSynchronizedAt = null;
        done.UpdatedAt = DateTime.UtcNow;
        await fixture.Db.MdToPptRuns.ReplaceOneAsync(item => item.Id == done.Id, done);

        Assert.Equal(1, await adapter.RecoverPendingAsync());
        var bound = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == done.Id).SingleAsync();
        Assert.Equal(site.Id, bound.ArtifactSiteId);
        Assert.Equal(revision.Id, bound.ArtifactRevisionId);
        Assert.DoesNotContain("hosted-content-", bound.ArtifactRevisionId, StringComparison.Ordinal);

        var failed = Run("recover-error", "convert", "running", string.Empty, null);
        await fixture.Db.MdToPptRuns.InsertOneAsync(failed);
        await adapter.BeginAsync(failed);
        failed.Status = "error";
        failed.Error = "provider body must remain private";
        failed.ArtifactContractSynchronizedAt = null;
        failed.UpdatedAt = DateTime.UtcNow;
        await fixture.Db.MdToPptRuns.ReplaceOneAsync(item => item.Id == failed.Id, failed);

        Assert.Equal(1, await adapter.RecoverPendingAsync());
        var recoveredFailure = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == failed.Id).SingleAsync();
        Assert.Equal(RunStatuses.Error, recoveredFailure.Status);
        Assert.Equal(HtmlPptDesignArtifactAdapter.RecoveryFailureCode, recoveredFailure.LifecycleFailureCode);
        Assert.Null(recoveredFailure.Error);
        var failureEvents = recoveredFailure.LifecycleEvents;
        Assert.Contains(failureEvents, record => record.Type == DesignArtifactLifecycleEventTypes.Run);
        Assert.Contains(failureEvents, record => record.Type == DesignArtifactLifecycleEventTypes.Error);
        Assert.DoesNotContain(
            "provider body must remain private",
            System.Text.Json.JsonSerializer.Serialize(failureEvents),
            StringComparison.Ordinal);

        await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() => adapter.BindPublishedAsync(
            done,
            site.Id,
            "hosted-content-untrusted",
            CancellationToken.None));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task Recovery_ShouldRecycleStaleRunningAndClearRetryState()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        var adapter = Adapter(fixture, new InMemoryRunEventStore());
        var stale = Run("stale-running", "convert", "running", string.Empty, null);
        stale.UpdatedAt = DateTime.UtcNow.Subtract(HtmlPptDesignArtifactAdapter.StaleRunTtl).AddMinutes(-1);
        stale.ArtifactRecoveryAttemptCount = 2;
        stale.ArtifactRecoveryNextAttemptAt = DateTime.UtcNow.AddMinutes(-1);
        stale.ArtifactRecoveryLastFailureCode = HtmlPptDesignArtifactAdapter.RecoveryFailureCode;
        await fixture.Db.MdToPptRuns.InsertOneAsync(stale);
        await adapter.BeginAsync(stale);

        Assert.Equal(1, await adapter.RecoverPendingAsync());

        var recoveredRun = await fixture.Db.MdToPptRuns.Find(item => item.Id == stale.Id).SingleAsync();
        Assert.Equal("error", recoveredRun.Status);
        Assert.Equal(0, recoveredRun.ArtifactRecoveryAttemptCount);
        Assert.Null(recoveredRun.ArtifactRecoveryNextAttemptAt);
        Assert.Null(recoveredRun.ArtifactRecoveryLastFailureCode);
        Assert.Null(recoveredRun.ArtifactRecoveryDeadLetteredAt);
        var publicRun = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == stale.Id).SingleAsync();
        Assert.Equal(HtmlPptDesignArtifactAdapter.StaleRunningFailureCode, publicRun.LifecycleFailureCode);
        Assert.Null(publicRun.Error);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishCoordinator_ShouldCreateOneSiteAndRealRevisionAcrossConcurrentRetries()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        const string html = "<!doctype html><html><head></head><body>publish</body></html>";
        var hash = MdToPptController.ComputeHtmlHash(html);
        var run = Run("publish-run", "convert", "done", html, hash);
        await fixture.Db.MdToPptRuns.InsertOneAsync(run);

        var contentVersion = new DateTime(2026, 9, 8, 2, 3, 4, DateTimeKind.Utc);
        var site = new HostedSite
        {
            Id = "idempotent-site",
            OwnerUserId = run.UserId,
            Title = run.Title,
            SiteUrl = "https://site.invalid/index.html",
            ContentVersion = contentVersion,
            SourceType = "md-to-ppt",
            SourceRef = HtmlPptPublishCoordinator.BuildIntentId(run.Id, hash),
        };
        var revision = new HostedSiteRevision
        {
            Id = "baseline-idempotent-site",
            SiteId = site.Id,
            CreatedByUserId = run.UserId,
            Status = HostedSiteRevisionStatuses.Published,
            Source = HostedSiteRevisionSources.Baseline,
            Runtime = DesignArtifactRuntimes.HtmlPptPipeline,
            SourceRunId = run.Id,
            Html = html,
            BasedOnContentVersion = contentVersion,
            PublishedContentVersion = contentVersion,
            CreatedAt = contentVersion,
            PublishedAt = contentVersion,
        };
        await fixture.Db.HostedSites.InsertOneAsync(site);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);

        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetTeamsNotPublishableAsync(
                run.UserId,
                It.IsAny<IReadOnlyCollection<string>>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync([]);
        sites.Setup(service => service.CreateFromHtmlIdempotentAsync(
                run.UserId,
                It.Is<byte[]>(bytes => Encoding.UTF8.GetString(bytes) == html),
                "index.html",
                run.Title,
                null,
                null,
                It.IsAny<List<string>?>(),
                "md-to-ppt",
                site.SourceRef!,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(site);
        sites.Setup(service => service.GetRevisionEntryHtmlAsync(
                site.Id,
                run.UserId,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(site, html, contentVersion));
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(service => service.EnsureGeneratedSnapshotAsync(
                site.Id,
                run.UserId,
                It.IsAny<HostedSiteEditableEntry>(),
                DesignArtifactRuntimes.HtmlPptPipeline,
                run.Id,
                It.IsAny<IReadOnlyCollection<string>>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(revision);
        var artifacts = new Mock<IHtmlPptDesignArtifactAdapter>(MockBehavior.Strict);
        artifacts.Setup(service => service.BindPublishedAsync(
                It.Is<MdToPptRun>(item => item.Id == run.Id),
                site.Id,
                revision.Id,
                It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        var coordinator = new HtmlPptPublishCoordinator(
            fixture.Db,
            sites.Object,
            revisions.Object,
            artifacts.Object,
            NullLogger<HtmlPptPublishCoordinator>.Instance);

        var attempts = await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
        {
            try
            {
                return await coordinator.PublishAsync(run, run.Title, null, [], []);
            }
            catch (HtmlPptPublishPendingException)
            {
                return null;
            }
        }));

        Assert.Contains(attempts, result => result?.Revision.Id == revision.Id);
        sites.Verify(service => service.CreateFromHtmlIdempotentAsync(
            It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<string?>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<List<string>?>(),
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Once);
        var persisted = await fixture.Db.MdToPptRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal("completed", persisted.PublishIntentStatus);
        Assert.Equal(site.Id, persisted.PublishedSiteId);
        Assert.Equal(revision.Id, persisted.PublishedVersionId);
        Assert.Equal(hash, persisted.PublishedHtmlHash);
        var persistedSite = await fixture.Db.HostedSites.Find(item => item.Id == site.Id).SingleAsync();
        Assert.Equal(revision.Id, persistedSite.PublishedRevisionId);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishCoordinator_ShouldClaimOrdinaryBaselineCreatedAfterSiteWriteBeforeRevisionWrite()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        const string html = "<!doctype html><html><head></head><body>claim baseline</body></html>";
        var hash = MdToPptController.ComputeHtmlHash(html);
        var run = Run("publish-claim-baseline", "convert", "done", html, hash);
        await fixture.Db.MdToPptRuns.InsertOneAsync(run);
        var contentVersion = new DateTime(2026, 9, 8, 3, 4, 5, DateTimeKind.Utc);
        var site = new HostedSite
        {
            Id = "claim-baseline-site",
            OwnerUserId = run.UserId,
            Title = run.Title,
            ContentVersion = contentVersion,
            SourceType = "md-to-ppt",
            SourceRef = HtmlPptPublishCoordinator.BuildIntentId(run.Id, hash),
        };
        await fixture.Db.HostedSites.InsertOneAsync(site);
        var entry = new HostedSiteEditableEntry(site, html, contentVersion);
        var calls = new List<string>();
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        HostedSiteRevisionService? revisions = null;
        sites.Setup(service => service.GetTeamsNotPublishableAsync(
                run.UserId,
                It.IsAny<IReadOnlyCollection<string>>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync([]);
        sites.Setup(service => service.CreateFromHtmlIdempotentAsync(
                run.UserId,
                It.Is<byte[]>(bytes => Encoding.UTF8.GetString(bytes) == html),
                "index.html",
                run.Title,
                null,
                null,
                It.IsAny<List<string>?>(),
                "md-to-ppt",
                site.SourceRef!,
                It.IsAny<CancellationToken>()))
            .Returns(() =>
            {
                calls.Add("create-site");
                return Task.FromResult(site);
            });
        sites.Setup(service => service.GetRevisionEntryHtmlAsync(
                site.Id,
                run.UserId,
                It.IsAny<CancellationToken>()))
            .Returns(async () =>
            {
                calls.Add("read-site");
                await revisions!.EnsureCurrentSnapshotAsync(site.Id, run.UserId, entry);
                calls.Add("ordinary-baseline");
                return entry;
            });
        revisions = new HostedSiteRevisionService(fixture.Db, sites.Object);
        var artifacts = new Mock<IHtmlPptDesignArtifactAdapter>(MockBehavior.Strict);
        artifacts.Setup(service => service.BindPublishedAsync(
                It.Is<MdToPptRun>(item => item.Id == run.Id),
                site.Id,
                It.IsAny<string>(),
                It.IsAny<CancellationToken>()))
            .Returns((MdToPptRun _, string _, string _, CancellationToken _) =>
            {
                calls.Add("bind-public-artifact");
                return Task.CompletedTask;
            });
        var coordinator = new HtmlPptPublishCoordinator(
            fixture.Db,
            sites.Object,
            revisions,
            artifacts.Object,
            NullLogger<HtmlPptPublishCoordinator>.Instance);

        var result = await coordinator.PublishAsync(run, run.Title, null, [], []);

        Assert.Equal(["create-site", "read-site", "ordinary-baseline", "bind-public-artifact"], calls);
        Assert.Equal(run.Id, result.Revision.SourceRunId);
        Assert.Equal(DesignArtifactRuntimes.HtmlPptPipeline, result.Revision.Runtime);
        Assert.Equal(hash, MdToPptController.ComputeHtmlHash(result.Revision.Html));
        Assert.Equal(1, await fixture.Db.HostedSiteRevisions.CountDocumentsAsync(_ => true));
        var persisted = await fixture.Db.HostedSiteRevisions.Find(item => item.Id == result.Revision.Id).SingleAsync();
        Assert.Equal(run.Id, persisted.SourceRunId);
        Assert.Equal(DesignArtifactRuntimes.HtmlPptPipeline, persisted.Runtime);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishCoordinator_OpenDesignPackage_ShouldReuseVerifiedSiteWithoutFlatteningAssets()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        const string authoredHtml = "<!doctype html><html><head><link rel=\"stylesheet\" href=\"assets/deck.css\"></head><body><div class=\"reveal\"><div class=\"slides\"><section>第一页</section></div></div></body></html>";
        const string hostedHtml = "<!doctype html><html><head><link rel=\"stylesheet\" href=\"./assets/deck.css\"></head><body><div class=\"reveal\"><div class=\"slides\"><section>第一页</section></div></div><script src=\"./assets/nav.js\"></script></body></html>";
        var sourceHash = MdToPptController.ComputeHtmlHash(authoredHtml);
        var run = Run("publish-open-design-package", "convert", "done", authoredHtml, sourceHash);
        run.Runtime = DesignArtifactRuntimes.OpenDesign;
        await fixture.Db.MdToPptRuns.InsertOneAsync(run);

        const string siteId = "open-design-ppt-site";
        const string revisionId = "open-design-ppt-revision";
        var now = new DateTime(2026, 10, 16, 1, 2, 3, DateTimeKind.Utc);
        var site = new HostedSite
        {
            Id = siteId,
            OwnerUserId = run.UserId,
            Title = run.Title,
            SourceType = "design-agent",
            SourceRef = run.Id,
            EntryFile = "index.html",
            SiteUrl = "https://site.invalid/open-design-ppt/index.html",
            ContentVersion = now,
            Files =
            [
                new HostedSiteFile { Path = "index.html", CosKey = "site/index.html", Size = Encoding.UTF8.GetByteCount(hostedHtml), MimeType = "text/html" },
                new HostedSiteFile { Path = "assets/deck.css", CosKey = "site/assets/deck.css", Size = 20, MimeType = "text/css" },
                new HostedSiteFile { Path = "assets/nav.js", CosKey = "site/assets/nav.js", Size = 20, MimeType = "text/javascript" },
            ],
        };
        var hostedBytes = Encoding.UTF8.GetBytes(hostedHtml);
        var cssBytes = Encoding.UTF8.GetBytes(".slides{display:block}");
        var navBytes = Encoding.UTF8.GetBytes("window.deckReady=true;");
        var revision = new HostedSiteRevision
        {
            Id = revisionId,
            SiteId = siteId,
            CreatedByUserId = run.UserId,
            Status = HostedSiteRevisionStatuses.Published,
            Source = HostedSiteRevisionSources.Baseline,
            Runtime = DesignArtifactRuntimes.OpenDesign,
            SourceRunId = run.Id,
            Html = hostedHtml,
            VerifiedFiles =
            [
                Verified("index.html", hostedBytes, "text/html"),
                Verified("assets/deck.css", cssBytes, "text/css"),
                Verified("assets/nav.js", navBytes, "text/javascript"),
            ],
            BasedOnContentVersion = now,
            PublishedContentVersion = now,
            CreatedAt = now,
            PublishedAt = now,
        };
        await fixture.Db.HostedSites.InsertOneAsync(site);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(new DesignArtifactRun
        {
            Id = run.Id,
            DeploymentSlug = DeploymentScope.Current,
            UserId = run.UserId,
            ArtifactType = DesignArtifactTypes.HtmlPpt,
            Operation = DesignArtifactOperations.Generate,
            Runtime = DesignArtifactRuntimes.OpenDesign,
            Status = RunStatuses.Done,
            ArtifactSiteId = siteId,
            ArtifactRevisionId = revisionId,
            ProducedArtifactSiteId = siteId,
            ProducedArtifactRevisionId = revisionId,
            WorkspaceResultSha256 = new string('a', 64),
        });

        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetTeamsNotPublishableAsync(
                run.UserId,
                It.IsAny<IReadOnlyCollection<string>>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync([]);
        sites.Setup(service => service.GetRevisionEntryHtmlAsync(siteId, run.UserId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(site, hostedHtml, now));
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        var artifacts = new Mock<IHtmlPptDesignArtifactAdapter>(MockBehavior.Strict);
        var coordinator = new HtmlPptPublishCoordinator(
            fixture.Db,
            sites.Object,
            revisions.Object,
            artifacts.Object,
            NullLogger<HtmlPptPublishCoordinator>.Instance);

        var result = await coordinator.PublishAsync(run, run.Title, null, [], []);

        Assert.Equal(siteId, result.Site.Id);
        Assert.Equal(revisionId, result.Revision.Id);
        Assert.Equal(sourceHash, result.ContentHash);
        Assert.Equal(3, result.Revision.VerifiedFiles.Count);
        Assert.Contains(result.Revision.VerifiedFiles, item => item.Path == "assets/deck.css");
        Assert.Contains(result.Revision.VerifiedFiles, item => item.Path == "assets/nav.js");
        sites.VerifyAll();
        revisions.VerifyNoOtherCalls();
        artifacts.VerifyNoOtherCalls();

        var replay = await coordinator.PublishAsync(run, run.Title, null, [], []);
        Assert.Equal(revisionId, replay.Revision.Id);
        Assert.Equal(sourceHash, replay.ContentHash);
    }

    [PptCompletionChainFact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishCoordinator_AuthoritativeManualPackage_ShouldPublishTheExactRuntimeRevision()
    {
        var outputDir = Environment.GetEnvironmentVariable("PPT_COMPLETION_CHAIN_OUTPUT_DIR")!;
        var publicationOutputDir = Environment.GetEnvironmentVariable("PPT_COMPLETION_PUBLICATION_OUTPUT_DIR")!;
        var sourcePlanPath = Environment.GetEnvironmentVariable("PPT_COMPLETION_SOURCE_PLAN_PATH")!;
        var sourcePlanJson = await File.ReadAllTextAsync(sourcePlanPath);
        var sourcePlanHash = Convert.ToHexString(
                System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(sourcePlanJson)))
            .ToLowerInvariant();
        Assert.Equal(
            "f811184612a2379787782f123531347bb4cd7db90600217d5f81f363fa3f3cb2",
            sourcePlanHash);
        using var sourcePlanDocument = JsonDocument.Parse(sourcePlanJson);
        var stableSourceHash = sourcePlanDocument.RootElement.GetProperty("Fingerprint").GetString();
        Assert.Equal("93fea52f8a30d753cf1d49e80732d8fd4bb788b53a138320e2b9e5d80de30646", stableSourceHash);
        var receiptJson = await File.ReadAllTextAsync(Path.Combine(outputDir, "runtime-chain-receipt.json"));
        using var receipt = JsonDocument.Parse(receiptJson);
        var generation = receipt.RootElement.GetProperty("generation");
        var manual = receipt.RootElement.GetProperty("manual");
        var resultPath = manual.GetProperty("resultPath").GetString()!;
        var resultBytes = await File.ReadAllBytesAsync(resultPath);
        Assert.Equal(
            manual.GetProperty("resultSha256").GetString(),
            Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(resultBytes)).ToLowerInvariant());
        Assert.Equal(
            generation.GetProperty("packageSha256").GetString(),
            manual.GetProperty("parentPackageSha256").GetString());

        var manualPackage = JsonSerializer.Deserialize<DesignWorkspacePackage>(
                          resultBytes,
                          new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                      ?? throw new InvalidOperationException("runtime completion package is missing");
        var parsedManual = DesignArtifactWorkspaceContract.ParseAndValidateResult(
            resultBytes,
            manualPackage.RunId,
            manualPackage.BaseRevision,
            DesignArtifactWorkspaceBroker.MaxOutputBytes);
        Assert.Equal(75, parsedManual.Files.Count);
        Assert.Equal(68, parsedManual.Files.Count(file => file.Path.StartsWith("assets/quality/", StringComparison.Ordinal)
                                                    && file.MediaType == "image/png"));
        var manualIndex = Assert.Single(parsedManual.Files, file => file.Path == "index.html");
        var manualHtml = Encoding.UTF8.GetString(Convert.FromBase64String(manualIndex.ContentBase64));
        var runtimeManualHtmlHash = MdToPptController.ComputeHtmlHash(manualHtml);

        var generationResultPath = generation.GetProperty("resultPath").GetString()!;
        var generationBytes = await File.ReadAllBytesAsync(generationResultPath);
        Assert.Equal(
            generation.GetProperty("resultSha256").GetString(),
            Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(generationBytes)).ToLowerInvariant());
        var generationPackage = JsonSerializer.Deserialize<DesignWorkspacePackage>(
                                    generationBytes,
                                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                                ?? throw new InvalidOperationException("runtime generation package is missing");
        var parsedGeneration = DesignArtifactWorkspaceContract.ParseAndValidateResult(
            generationBytes,
            generationPackage.RunId,
            generationPackage.BaseRevision,
            DesignArtifactWorkspaceBroker.MaxOutputBytes);
        var generationIndex = Assert.Single(parsedGeneration.Files, file => file.Path == "index.html");
        var generationHtml = Encoding.UTF8.GetString(Convert.FromBase64String(generationIndex.ContentBase64));
        const string ordinaryCompat = "<html><body>正文<!--map-slide-nav-compat--><script>compat()</script></body></html>";
        const string trustedCompat = "<html><body>正文<!--map-slide-nav-compat--><!--map-slide-nav-bridge-only--><script>bridge()</script></body></html>";
        const string unmarkedScript = "<html><body>正文<script>application()</script></body></html>";
        const string orphanBridgeMarker = "<html><body>正文<!--map-slide-nav-bridge-only--><script>application()</script></body></html>";
        const string normalizedWithoutCompat = "<html><body>正文</body></html>";
        Assert.Equal(
            normalizedWithoutCompat,
            DesignArtifactWorkspaceContract.NormalizeCurrentHtmlForRemoteEditing(ordinaryCompat));
        Assert.Equal(
            normalizedWithoutCompat,
            DesignArtifactWorkspaceContract.NormalizeCurrentHtmlForRemoteEditing(trustedCompat));
        Assert.Equal(
            unmarkedScript,
            DesignArtifactWorkspaceContract.NormalizeCurrentHtmlForRemoteEditing(unmarkedScript));
        Assert.Equal(
            unmarkedScript,
            DesignArtifactWorkspaceContract.NormalizeCurrentHtmlForRemoteEditing(orphanBridgeMarker));

        await using var fixture = await AdapterMongoFixture.CreateAsync();
        var assetRoot = Path.Combine(Path.GetTempPath(), $"ppt-completion-assets-{Guid.NewGuid():N}");
        var keyRoot = Path.Combine(Path.GetTempPath(), $"ppt-completion-keys-{Guid.NewGuid():N}");
        Directory.CreateDirectory(assetRoot);
        Directory.CreateDirectory(keyRoot);
        try
        {
            var storage = new LocalAssetStorage(assetRoot);
            var sites = CreateHostedSiteService(fixture.Db, storage);
            var revisions = new HostedSiteRevisionService(fixture.Db, sites, storage);
            var capability = new DesignArtifactProviderCapability(
                DesignArtifactRuntimes.OpenDesign,
                "OpenDesign",
                DesignArtifactAdapterKinds.RemoteAgent,
                DesignArtifactExecutionOwners.CdsRemoteAgent,
                DesignArtifactIsolationModes.SessionContainer,
                [DesignArtifactTypes.HtmlPpt],
                [DesignArtifactOperations.Generate, DesignArtifactOperations.Edit],
                [DesignArtifactSourceSurfaces.HtmlPpt],
                Configured: true,
                Healthy: true,
                Enabled: true,
                Reason: null,
                ConnectionId: "test-local");
            var parentCompatibility = Run(
                generationPackage.RunId,
                "convert",
                "running",
                string.Empty,
                null);
            parentCompatibility.Runtime = DesignArtifactRuntimes.OpenDesign;
            parentCompatibility.SourcePlanJson = sourcePlanJson;
            parentCompatibility.SourcePlanHash = sourcePlanHash;
            await fixture.Db.MdToPptRuns.InsertOneAsync(parentCompatibility);

            var generationDesignRun = new DesignArtifactRun
            {
                Id = generationPackage.RunId,
                DeploymentSlug = DeploymentScope.Current,
                UserId = parentCompatibility.UserId,
                Status = RunStatuses.Queued,
                ArtifactType = DesignArtifactTypes.HtmlPpt,
                Operation = DesignArtifactOperations.Generate,
                SourceSurface = DesignArtifactSourceSurfaces.HtmlPpt,
                Runtime = DesignArtifactRuntimes.OpenDesign,
                Instruction = "按冻结来源生成完整演示稿",
                Title = parentCompatibility.Title,
                KnowledgeReferences = [],
                UserSuppliedContentHash = parentCompatibility.UserSuppliedContentHash,
                ParentPlanRunId = parentCompatibility.ParentOutlineRunId,
                ParentPlanContentHash = parentCompatibility.ParentPlanContentHash,
                PresentationInput = new DesignArtifactPresentationInput
                {
                    TargetPages = 34,
                    SourcePlanJson = sourcePlanJson,
                    SourcePlanHash = sourcePlanHash,
                },
            };
            WebPageDesignArtifactLifecycleAdapter.InitializeNewRun(
                generationDesignRun,
                capability,
                currentHtml: null);
            await fixture.Db.DesignArtifactRuns.InsertOneAsync(generationDesignRun);

            var grants = new Mock<IDesignArtifactGatewayGrantService>(MockBehavior.Strict);
            var broker = new DesignArtifactWorkspaceBroker(
                fixture.Db,
                storage,
                DataProtectionProvider.Create(new DirectoryInfo(keyRoot)),
                new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["DesignArtifactRuntime:PublicBaseUrl"] = "https://map.example.test",
                }).Build(),
                grants.Object,
                sites);
            var events = new InMemoryRunEventStore();
            var lifecycle = new DesignArtifactLifecycleService(fixture.Db, events);
            var publicLifecycle = new WebPageDesignArtifactLifecycleAdapter(
                fixture.Db,
                lifecycle,
                broker,
                NullLogger<WebPageDesignArtifactLifecycleAdapter>.Instance);
            var executor = new ExactWorkspacePackageExecutor(
                fixture.Db,
                broker,
                new Dictionary<string, ExactWorkspaceReplay>
                {
                    [generationDesignRun.Id] = new(generationPackage.BaseRevision, generationBytes),
                    [manualPackage.RunId] = new(manualPackage.BaseRevision, resultBytes),
                });
            var services = new ServiceCollection();
            services.AddSingleton(fixture.Db);
            services.AddSingleton<IHostedSiteService>(sites);
            services.AddSingleton<IHostedSiteRevisionService>(revisions);
            services.AddSingleton<IDesignArtifactLifecycleService>(lifecycle);
            services.AddSingleton<IWebPageDesignArtifactLifecycleAdapter>(publicLifecycle);
            services.AddSingleton(Mock.Of<IDesignKnowledgeSnapshotResolver>());
            services.AddSingleton(Mock.Of<IActivityActionRecorder>());
            services.AddSingleton<IDesignArtifactExecutor>(executor);
            using var provider = services.BuildServiceProvider();
            using var worker = new HostedSiteEditRunWorker(
                provider.GetRequiredService<IServiceScopeFactory>(),
                Mock.Of<IRunQueue>(),
                events,
                NullLogger<HostedSiteEditRunWorker>.Instance);

            await worker.ProcessAsync(generationDesignRun.Id, CancellationToken.None);

            var completedGeneration = await fixture.Db.DesignArtifactRuns
                .Find(item => item.Id == generationDesignRun.Id)
                .SingleAsync();
            Assert.Equal(RunStatuses.Done, completedGeneration.Status);
            Assert.Equal(generation.GetProperty("resultSha256").GetString(), completedGeneration.WorkspaceResultSha256);
            Assert.Equal(completedGeneration.ArtifactSiteId, completedGeneration.ProducedArtifactSiteId);
            Assert.Equal(completedGeneration.ArtifactRevisionId, completedGeneration.ProducedArtifactRevisionId);
            Assert.NotNull(completedGeneration.ArtifactSiteId);
            Assert.NotNull(completedGeneration.ArtifactRevisionId);
            Assert.Null(executor.CurrentHtmlFor(generationDesignRun.Id));
            Assert.Equal(
                generation.GetProperty("resultSha256").GetString(),
                executor.CommitFor(generationDesignRun.Id).ResultSha256);
            Assert.Contains(
                executor.PreparedPackageFor(generationDesignRun.Id).Files,
                file => file.Path == "brief/source-plan.json");
            parentCompatibility = await fixture.Db.MdToPptRuns
                .Find(item => item.Id == generationPackage.RunId)
                .SingleAsync();
            Assert.Equal("done", parentCompatibility.Status);
            Assert.Equal(sourcePlanHash, parentCompatibility.SourcePlanHash);
            Assert.Equal(completedGeneration.ArtifactSiteId, parentCompatibility.PublishedSiteId);
            Assert.Equal(completedGeneration.ArtifactRevisionId, parentCompatibility.PublishedVersionId);
            Assert.Null(parentCompatibility.PublishIntentStatus);
            var hostedGenerationHtml = parentCompatibility.Html;
            Assert.NotEqual(generationHtml, hostedGenerationHtml);
            var parentSite = await fixture.Db.HostedSites
                .Find(item => item.Id == completedGeneration.ArtifactSiteId)
                .SingleAsync();
            var parentRevision = await fixture.Db.HostedSiteRevisions
                .Find(item => item.Id == completedGeneration.ArtifactRevisionId)
                .SingleAsync();
            Assert.Equal(generationPackage.RunId, parentRevision.SourceRunId);
            Assert.Equal(completedGeneration.ArtifactRevisionId, parentRevision.Id);
            Assert.Equal(hostedGenerationHtml, parentRevision.Html);
            Assert.Equal(parentRevision.Id, parentSite.PublishedRevisionId);
            Assert.Equal(parentSite.ContentVersion, parentRevision.PublishedContentVersion);
            var coordinator = new HtmlPptPublishCoordinator(
                fixture.Db,
                sites,
                revisions,
                Adapter(fixture, new InMemoryRunEventStore()),
                NullLogger<HtmlPptPublishCoordinator>.Instance,
                publicLifecycle);

            var compatibility = Run(
                manualPackage.RunId,
                "manual-edit",
                "running",
                string.Empty,
                null,
                manual.GetProperty("parentRunId").GetString(),
                parentCompatibility.HtmlHash);
            Assert.Equal(parentCompatibility.Id, compatibility.ParentRunId);
            compatibility.Runtime = DesignArtifactRuntimes.OpenDesign;
            compatibility.SourcePlanJson = sourcePlanJson;
            compatibility.SourcePlanHash = sourcePlanHash;
            await fixture.Db.MdToPptRuns.InsertOneAsync(compatibility);

            var designRun = new DesignArtifactRun
            {
                Id = manualPackage.RunId,
                DeploymentSlug = DeploymentScope.Current,
                UserId = compatibility.UserId,
                Status = RunStatuses.Queued,
                ArtifactType = DesignArtifactTypes.HtmlPpt,
                Operation = DesignArtifactOperations.Edit,
                SourceSurface = DesignArtifactSourceSurfaces.HtmlPpt,
                Runtime = DesignArtifactRuntimes.OpenDesign,
                Instruction = "保留完整来源并完成两处等义编辑",
                Title = compatibility.Title,
                KnowledgeReferences = [],
                UserSuppliedContentHash = compatibility.UserSuppliedContentHash,
                ParentPlanRunId = compatibility.ParentOutlineRunId,
                ParentPlanContentHash = compatibility.ParentPlanContentHash,
                PresentationInput = new DesignArtifactPresentationInput
                {
                    ParentRunId = manual.GetProperty("parentRunId").GetString(),
                    ParentPackageHash = generation.GetProperty("packageSha256").GetString(),
                    TargetPages = 34,
                    SourcePlanJson = sourcePlanJson,
                    SourcePlanHash = sourcePlanHash,
                },
            };
            WebPageDesignArtifactLifecycleAdapter.InitializeNewRun(
                designRun,
                capability,
                generationHtml);
            designRun.TargetSiteId = parentSite.Id;
            designRun.Status = RunStatuses.Queued;
            designRun.LeaseOwnerId = null;
            designRun.LeaseExpiresAt = null;
            await fixture.Db.DesignArtifactRuns.InsertOneAsync(designRun);
            var persistedGenerationPackage = await broker.ReadResultAsync(
                completedGeneration.Id,
                CancellationToken.None);
            Assert.Equal(
                DesignArtifactWorkspaceContract.NormalizeCurrentHtmlForRemoteEditing(
                    persistedGenerationPackage.IndexHtml),
                DesignArtifactWorkspaceContract.NormalizeCurrentHtmlForRemoteEditing(
                    hostedGenerationHtml));
            Assert.Equal(
                completedGeneration.WorkspaceResultSha256,
                designRun.PresentationInput.ParentPackageHash);
            Assert.Equal(parentSite.Id, completedGeneration.ArtifactSiteId);
            Assert.Equal(parentSite.Id, completedGeneration.ProducedArtifactSiteId);
            Assert.Equal(parentRevision.Id, completedGeneration.ArtifactRevisionId);
            Assert.Equal(parentRevision.Id, completedGeneration.ProducedArtifactRevisionId);
            Assert.Equal(parentRevision.Id, parentSite.PublishedRevisionId);
            Assert.Equal(parentSite.ContentVersion, parentRevision.PublishedContentVersion);

            var hostedManualFiles = HostedSiteEditRunWorker.PrepareWorkspaceFilesForHosting(
                sites,
                parsedManual.Files,
                manualHtml,
                trustedPresentation: true);
            var hostedManualHtml = Encoding.UTF8.GetString(Convert.FromBase64String(
                Assert.Single(hostedManualFiles, file => file.Path == "index.html").ContentBase64));
            var hostedManualHtmlHash = MdToPptController.ComputeHtmlHash(hostedManualHtml);
            Assert.NotEqual(runtimeManualHtmlHash, hostedManualHtmlHash);
            Assert.Equal(parsedManual.Files.Count, hostedManualFiles.Count);
            foreach (var original in parsedManual.Files.Where(file => file.Path != "index.html"))
            {
                var hosted = Assert.Single(hostedManualFiles, file => file.Path == original.Path);
                Assert.Equal(original.Sha256, hosted.Sha256);
                Assert.Equal(original.ContentBase64, hosted.ContentBase64);
            }
            var hostedAgain = HostedSiteEditRunWorker.PrepareWorkspaceFilesForHosting(
                sites,
                hostedManualFiles,
                hostedManualHtml,
                trustedPresentation: true);
            Assert.Equal(
                JsonSerializer.Serialize(hostedManualFiles),
                JsonSerializer.Serialize(hostedAgain));

            await worker.ProcessAsync(designRun.Id, CancellationToken.None);

            var completedDesign = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == designRun.Id).SingleAsync();
            Assert.True(
                completedDesign.Status == RunStatuses.Done,
                $"manual worker ended as {completedDesign.Status}: {completedDesign.Error}; runtime={completedDesign.RuntimeFailure?.Code}");
            Assert.Equal(hostedGenerationHtml, executor.CurrentHtmlFor(designRun.Id));
            Assert.Equal(parentSite.Id, completedDesign.TargetSiteId);
            Assert.Equal(executor.CommitFor(designRun.Id).ResultSha256, completedDesign.WorkspaceResultSha256);
            Assert.Equal(manual.GetProperty("resultSha256").GetString(), completedDesign.WorkspaceResultSha256);
            Assert.Equal(
                parsedManual.Files.Single(file => file.Path == "manifest.json").Sha256,
                completedDesign.WorkspaceManifestSha256);
            Assert.Null(completedDesign.ArtifactSiteId);
            Assert.Null(completedDesign.ArtifactRevisionId);
            Assert.Equal(parentSite.Id, completedDesign.ProducedArtifactSiteId);
            Assert.NotNull(completedDesign.ProducedArtifactRevisionId);
            Assert.NotEqual(parentRevision.Id, completedDesign.ProducedArtifactRevisionId);
            var manifestHashes = DesignArtifactLifecycleService.ComputeManifestHashes(completedDesign.Manifest!);
            Assert.Equal(manifestHashes.PackageHash, completedDesign.VersionBoundary?.PackageHash);
            Assert.Equal(manifestHashes.CanonicalManifestHash, completedDesign.VersionBoundary?.CanonicalManifestHash);

            var preparedPackage = executor.PreparedPackageFor(designRun.Id);
            Assert.Contains(preparedPackage.Files, file => file.Path == "current/index.html");
            Assert.Contains(preparedPackage.Files, file => file.Path == "brief/source-plan.json");
            Assert.Equal(
                generationHtml,
                Encoding.UTF8.GetString(Convert.FromBase64String(
                    Assert.Single(preparedPackage.Files, file => file.Path == "current/index.html").ContentBase64)));
            Assert.DoesNotContain(preparedPackage.Files, file =>
                file.Path.StartsWith("current/assets/quality/", StringComparison.OrdinalIgnoreCase)
                || DesignArtifactWorkspaceBroker.IsPresentationRuntimeEvidencePath(
                    file.Path.StartsWith("current/", StringComparison.Ordinal)
                        ? file.Path["current/".Length..]
                        : file.Path));

            var completedCompatibility = await fixture.Db.MdToPptRuns
                .Find(item => item.Id == compatibility.Id)
                .SingleAsync();
            Assert.Equal("done", completedCompatibility.Status);
            Assert.Equal(completedDesign.Id, completedCompatibility.Id);
            Assert.Equal(parentCompatibility.Id, completedCompatibility.ParentRunId);
            Assert.Equal(sourcePlanHash, completedCompatibility.SourcePlanHash);
            Assert.Null(completedCompatibility.PublishIntentStatus);
            Assert.Equal(hostedManualHtml, completedCompatibility.Html);
            Assert.Equal(hostedManualHtmlHash, completedCompatibility.HtmlHash);
            Assert.Contains("完成链用户修订稿", completedCompatibility.Html, StringComparison.Ordinal);
            Assert.Contains("（用户确认的等义表述）", completedCompatibility.Html, StringComparison.Ordinal);
            Assert.Equal(parentSite.Id, completedCompatibility.PublishedSiteId);
            Assert.Equal(completedDesign.ProducedArtifactRevisionId, completedCompatibility.PublishedVersionId);

            var manualDraft = await fixture.Db.HostedSiteRevisions
                .Find(item => item.Id == completedDesign.ProducedArtifactRevisionId)
                .SingleAsync();
            Assert.Equal(parentSite.Id, manualDraft.SiteId);
            Assert.Equal(parentRevision.Id, manualDraft.ParentRevisionId);
            Assert.Equal(completedDesign.Id, manualDraft.SourceRunId);
            Assert.Equal(HostedSiteRevisionStatuses.Draft, manualDraft.Status);

            var parentAfterWorker = await fixture.Db.HostedSites.Find(item => item.Id == parentSite.Id).SingleAsync();
            Assert.Equal(parentSite.PublishedRevisionId, parentAfterWorker.PublishedRevisionId);
            Assert.Equal(parentSite.ContentVersion, parentAfterWorker.ContentVersion);
            Assert.Equal(
                parentSite.Files.OrderBy(file => file.Path).Select(file => (file.Path, file.CosKey, file.Size)),
                parentAfterWorker.Files.OrderBy(file => file.Path).Select(file => (file.Path, file.CosKey, file.Size)));

            var published = await coordinator.PublishAsync(
                completedCompatibility,
                completedCompatibility.Title,
                null,
                [],
                []);

            Assert.Equal(parentSite.Id, published.Site.Id);
            Assert.Equal(completedDesign.ProducedArtifactRevisionId, published.Revision.Id);
            Assert.Equal(HostedSiteRevisionStatuses.Published, published.Revision.Status);
            Assert.Equal(hostedManualHtmlHash, published.ContentHash);
            Assert.Equal(hostedManualFiles.Count, published.Revision.VerifiedFiles.Count);
            foreach (var expected in hostedManualFiles)
            {
                var actual = Assert.Single(published.Revision.VerifiedFiles, file => file.Path == expected.Path);
                Assert.Equal(expected.Sha256, actual.Sha256);
                Assert.Equal(Convert.FromBase64String(expected.ContentBase64), actual.Content);
            }
            var publishedRun = await fixture.Db.MdToPptRuns.Find(item => item.Id == compatibility.Id).SingleAsync();
            Assert.Equal("completed", publishedRun.PublishIntentStatus);
            Assert.Equal(completedDesign.ProducedArtifactRevisionId, publishedRun.PublishedVersionId);
            Assert.Equal(hostedManualHtmlHash, publishedRun.PublishedHtmlHash);
            var boundDesign = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == designRun.Id).SingleAsync();
            Assert.Equal(parentSite.Id, boundDesign.ArtifactSiteId);
            Assert.Equal(completedDesign.ProducedArtifactRevisionId, boundDesign.ArtifactRevisionId);

            var rollback = await revisions.RollbackAsync(
                parentSite.Id,
                parentRevision.Id,
                compatibility.UserId,
                "ppt-completion-rollback-0001");
            Assert.Equal(parentRevision.Id, rollback.Revision.RollbackTargetRevisionId);
            Assert.Equal(parentSite.Id, rollback.Site.Id);
            Assert.Equal(parentRevision.Html, rollback.Revision.Html);
            Assert.NotEqual(published.Revision.Id, rollback.Revision.Id);

            Directory.CreateDirectory(publicationOutputDir);
            var publishedEntry = Assert.Single(published.Revision.VerifiedFiles, file => file.Path == "index.html");
            var publishedEntryPath = Path.Combine(publicationOutputDir, "published-index.html");
            await File.WriteAllBytesAsync(publishedEntryPath, publishedEntry.Content);
            var publicationReceipt = JsonSerializer.SerializeToUtf8Bytes(new
            {
                schema = "map-ppt-free-completion-publication-v3",
                capturedAt = DateTime.UtcNow,
                sourcePlanSha256 = sourcePlanHash,
                stableSourceHash,
                generationResultSha256 = generation.GetProperty("resultSha256").GetString(),
                generationWorkspaceResultSha256 = completedGeneration.WorkspaceResultSha256,
                generationManifestPackageHash = completedGeneration.VersionBoundary?.PackageHash,
                generationRunId = completedGeneration.Id,
                generationCompatibilityStatus = parentCompatibility.Status,
                generationSiteId = completedGeneration.ArtifactSiteId,
                generationRevisionId = completedGeneration.ArtifactRevisionId,
                generationWorkerProjection = true,
                runtimeResultSha256 = manual.GetProperty("resultSha256").GetString(),
                runtimeEntrySha256 = manualIndex.Sha256,
                publishedEntrySha256 = hostedManualHtmlHash,
                publishedPackageSha256 = completedDesign.VersionBoundary?.PackageHash,
                workspaceManifestSha256 = completedDesign.WorkspaceManifestSha256,
                publishedFileCount = published.Revision.VerifiedFiles.Count,
                browserEvidenceCount = published.Revision.VerifiedFiles.Count(file =>
                    file.Path.StartsWith("assets/quality/", StringComparison.Ordinal)
                    && file.MimeType == "image/png"),
                siteId = published.Site.Id,
                revisionId = published.Revision.Id,
                runId = completedDesign.Id,
                compatibilityStatus = completedCompatibility.Status,
                manualWorkerProjection = true,
                targetParentSiteId = completedDesign.TargetSiteId,
                sameSiteDraftPublished = true,
                rollbackRevisionId = rollback.Revision.Id,
                rollbackTargetRevisionId = rollback.Revision.RollbackTargetRevisionId,
                entryPath = publishedEntryPath,
            }, new JsonSerializerOptions { WriteIndented = true });
            await File.WriteAllBytesAsync(
                Path.Combine(publicationOutputDir, "publication-receipt.json"),
                publicationReceipt);
        }
        finally
        {
            if (Directory.Exists(assetRoot)) Directory.Delete(assetRoot, recursive: true);
            if (Directory.Exists(keyRoot)) Directory.Delete(keyRoot, recursive: true);
        }
    }

    private static HostedSiteService CreateHostedSiteService(MongoDbContext db, IAssetStorage storage)
    {
        var teams = new Mock<ITeamService>();
        teams.Setup(service => service.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync([]);
        return new HostedSiteService(
            db,
            storage,
            Mock.Of<IShortLinkService>(),
            Mock.Of<ISharePasswordService>(),
            teams.Object,
            Mock.Of<ITeamActivityService>(),
            Mock.Of<IUploadProgressService>(),
            Mock.Of<IAskOpeningQuestionGenerator>(),
            NullLogger<HostedSiteService>.Instance);
    }

    private static HostedSiteRevisionFile Verified(string path, byte[] bytes, string mimeType) => new()
    {
        Path = path,
        Content = bytes,
        Sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(),
        MimeType = mimeType,
    };

    private sealed record ExactWorkspaceReplay(string BaseRevision, byte[] ResultBytes);

    private sealed class ExactWorkspacePackageExecutor(
        MongoDbContext db,
        IDesignArtifactWorkspaceBroker broker,
        IReadOnlyDictionary<string, ExactWorkspaceReplay> replays) : IDesignArtifactExecutor
    {
        private readonly Dictionary<string, DesignWorkspacePackage> _preparedPackages = new(StringComparer.Ordinal);
        private readonly Dictionary<string, DesignArtifactResultCommit> _commits = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string?> _currentHtml = new(StringComparer.Ordinal);

        public string Runtime => DesignArtifactRuntimes.OpenDesign;

        public DesignWorkspacePackage PreparedPackageFor(string runId) => _preparedPackages[runId];
        public DesignArtifactResultCommit CommitFor(string runId) => _commits[runId];
        public string? CurrentHtmlFor(string runId) => _currentHtml[runId];

        public bool Supports(string artifactType, string operation) =>
            artifactType == DesignArtifactTypes.HtmlPpt
            && operation is DesignArtifactOperations.Generate or DesignArtifactOperations.Edit;

        public async IAsyncEnumerable<DesignArtifactExecutorChunk> ExecuteAsync(
            DesignArtifactRun run,
            string? currentHtml,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
        {
            if (!replays.TryGetValue(run.Id, out var replay))
                throw new InvalidOperationException("worker received an unexpected presentation run");
            _currentHtml[run.Id] = currentHtml;
            var prepared = await broker.PrepareAsync(run, currentHtml, ct);
            var inputBytes = await broker.ReadInputPackageAsync(run.Id, prepared.TransferToken, ct);
            _preparedPackages[run.Id] = JsonSerializer.Deserialize<DesignWorkspacePackage>(
                                           inputBytes,
                                           new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                                       ?? throw new InvalidOperationException("workspace package is missing");

            // 这份零供应商回放包在前一阶段已冻结了自己的确定性 baseRevision。测试只把当前
            // Worker 已持有租约的工作区窗口对齐到该 revision，随后仍由真实 Broker 验证并
            // 持久化原始 75 文件结果；不改结果字节，也不伪造任务完成态。
            var rebound = await db.DesignArtifactRuns.UpdateOneAsync(
                item => item.Id == run.Id && item.LeaseOwnerId == run.LeaseOwnerId,
                Builders<DesignArtifactRun>.Update.Set(
                    item => item.WorkspaceBaseRevision,
                    replay.BaseRevision),
                cancellationToken: CancellationToken.None);
            if (rebound.ModifiedCount != 1)
                throw new InvalidOperationException("failed to bind the replay package base revision");
            run.WorkspaceBaseRevision = replay.BaseRevision;

            _commits[run.Id] = await broker.CommitResultAsync(
                run.Id,
                prepared.TransferToken,
                replay.ResultBytes,
                ct);
            var parsed = DesignArtifactWorkspaceContract.ParseAndValidateResult(
                replay.ResultBytes,
                run.Id,
                replay.BaseRevision,
                DesignArtifactWorkspaceBroker.MaxOutputBytes);
            var entry = parsed.Files.Single(file => file.Path == "index.html");
            var html = Encoding.UTF8.GetString(Convert.FromBase64String(entry.ContentBase64));
            yield return new DesignArtifactExecutorChunk("delta", html, parsed.Files);
        }
    }

    private sealed class PptCompletionChainFactAttribute : FactAttribute
    {
        public PptCompletionChainFactAttribute()
        {
            var outputDir = Environment.GetEnvironmentVariable("PPT_COMPLETION_CHAIN_OUTPUT_DIR");
            var publicationOutputDir = Environment.GetEnvironmentVariable("PPT_COMPLETION_PUBLICATION_OUTPUT_DIR");
            if (string.IsNullOrWhiteSpace(outputDir)
                || string.IsNullOrWhiteSpace(publicationOutputDir)
                || !File.Exists(Path.Combine(outputDir, "runtime-chain-receipt.json"))
                || !File.Exists(Path.Combine(outputDir, "manual-result.json"))
                || !File.Exists(Environment.GetEnvironmentVariable("PPT_COMPLETION_SOURCE_PLAN_PATH")))
            {
                Skip = "Requires the zero-provider PPT completion runtime-chain receipt.";
            }
        }
    }

    [Fact]
    public void PublishIdentifiersAndBackoff_ShouldBeDeterministicAndBounded()
    {
        var hash = new string('a', 64);
        Assert.Equal(
            HtmlPptPublishCoordinator.BuildIntentId("run-1", hash),
            HtmlPptPublishCoordinator.BuildIntentId("run-1", hash.ToUpperInvariant()));
        Assert.NotEqual(
            HtmlPptPublishCoordinator.BuildIntentId("run-1", hash),
            HtmlPptPublishCoordinator.BuildIntentId("run-2", hash));
        Assert.Equal(
            MdToPptController.BuildNormalizedRunId("run-1", hash),
            MdToPptController.BuildNormalizedRunId("run-1", hash.ToUpperInvariant()));
        Assert.Equal(TimeSpan.FromSeconds(5), HtmlPptPublishCoordinator.Backoff(1));
        Assert.Equal(TimeSpan.FromMinutes(5), HtmlPptPublishCoordinator.Backoff(100));
        Assert.Equal(TimeSpan.FromSeconds(5), HtmlPptDesignArtifactAdapter.RecoveryBackoff(1));
        Assert.Equal(TimeSpan.FromMinutes(5), HtmlPptDesignArtifactAdapter.RecoveryBackoff(100));
        Assert.Equal(
            HostedSiteService.BuildIdempotentHtmlSiteId("owner", "source"),
            HostedSiteService.BuildIdempotentHtmlSiteId(" owner ", " source "));
        Assert.NotEqual(
            HostedSiteService.BuildIdempotentHtmlSiteId("owner", "source"),
            HostedSiteService.BuildIdempotentHtmlSiteId("owner", "other"));

        var original = Encoding.UTF8.GetBytes("<!doctype html><html><body><a href=\"/asset.css\">deck</a></body></html>");
        var prepared = HostedSiteService.RewritePublishedEntryHtml(original, "index.html");
        var preparedAgain = HostedSiteService.RewritePublishedEntryHtml(prepared, "index.html");
        Assert.Equal(prepared, preparedAgain);
    }

    [Fact]
    public void HostedWorkspacePreparation_ShouldPreserveVerifiedWebPackageIncludingManifest()
    {
        const string html = "<!doctype html><html><body><main>deck</main></body></html>";
        var htmlBytes = Encoding.UTF8.GetBytes(html);
        var cssBytes = Encoding.UTF8.GetBytes("main { display: grid; }");
        var manifestBytes = JsonSerializer.SerializeToUtf8Bytes(new
        {
            files = new[]
            {
                new { path = "index.html", sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(htmlBytes)).ToLowerInvariant(), size = htmlBytes.Length },
                new { path = "assets/deck.css", sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(cssBytes)).ToLowerInvariant(), size = cssBytes.Length },
            },
        });
        var files = new[]
        {
            new DesignWorkspaceFile(
                "index.html",
                Convert.ToBase64String(htmlBytes),
                Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(htmlBytes)).ToLowerInvariant(),
                htmlBytes.LongLength,
                "text/html"),
            new DesignWorkspaceFile(
                "assets/deck.css",
                Convert.ToBase64String(cssBytes),
                Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(cssBytes)).ToLowerInvariant(),
                cssBytes.LongLength,
                "text/css"),
            new DesignWorkspaceFile(
                "manifest.json",
                Convert.ToBase64String(manifestBytes),
                Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(manifestBytes)).ToLowerInvariant(),
                manifestBytes.LongLength,
                "application/json"),
        };
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.PrepareHtmlForHosting(It.IsAny<byte[]>(), "index.html"))
            .Returns((byte[] bytes, string _) => HostedSiteService.RewritePublishedEntryHtml(bytes, "index.html"));
        sites.Setup(service => service.PrepareTrustedPresentationHtmlForHosting(It.IsAny<byte[]>(), "index.html"))
            .Returns((byte[] bytes, string _) => HostedSiteService.RewritePublishedEntryHtml(bytes, "index.html", bridgeOnly: true));

        var prepared = HostedSiteEditRunWorker.PrepareWorkspaceFilesForHosting(
            sites.Object, files, html, preserveVerifiedWebPackage: true);
        var preparedHtml = Encoding.UTF8.GetString(Convert.FromBase64String(
            Assert.Single(prepared, file => file.Path == "index.html").ContentBase64));
        var preparedAgain = HostedSiteEditRunWorker.PrepareWorkspaceFilesForHosting(
            sites.Object,
            prepared,
            preparedHtml,
            preserveVerifiedWebPackage: true);

        Assert.Equal(html, preparedHtml);
        Assert.Equal(JsonSerializer.Serialize(files), JsonSerializer.Serialize(prepared));
        Assert.Equal(JsonSerializer.Serialize(prepared), JsonSerializer.Serialize(preparedAgain));
        var originalCss = Assert.Single(files, file => file.Path == "assets/deck.css");
        var preparedCss = Assert.Single(prepared, file => file.Path == "assets/deck.css");
        Assert.Equal(originalCss, preparedCss);
        using var manifest = JsonDocument.Parse(Convert.FromBase64String(
            Assert.Single(prepared, file => file.Path == "manifest.json").ContentBase64));
        foreach (var record in manifest.RootElement.GetProperty("files").EnumerateArray())
        {
            var file = Assert.Single(prepared, item => item.Path == record.GetProperty("path").GetString());
            var content = Convert.FromBase64String(file.ContentBase64);
            Assert.Equal(record.GetProperty("size").GetInt64(), content.LongLength);
            Assert.Equal(record.GetProperty("sha256").GetString(), file.Sha256);
        }
        sites.Verify(service => service.PrepareHtmlForHosting(It.IsAny<byte[]>(), "index.html"), Times.Never);
        sites.Verify(service => service.PrepareTrustedPresentationHtmlForHosting(It.IsAny<byte[]>(), "index.html"), Times.Never);
    }

    [Fact]
    public void TrustedPresentationHosting_ShouldKeepBridgeWithoutAddingASecondVisualNavigationLayer()
    {
        const string html = "<!doctype html><html><body><main class=\"reveal\"><div class=\"slides\"><section>deck</section></div></main><nav aria-label=\"演示稿导航\"><button>上一页</button><button>下一页</button></nav></body></html>";
        var source = Encoding.UTF8.GetBytes(html);

        var ordinary = HostedSiteService.RewritePublishedEntryHtml(source, "index.html");
        var trusted = HostedSiteService.RewritePublishedEntryHtml(source, "index.html", bridgeOnly: true);
        var normalizedAgain = HostedSiteService.RewritePublishedEntryHtml(trusted, "index.html");
        var ordinaryText = Encoding.UTF8.GetString(ordinary);
        var trustedText = Encoding.UTF8.GetString(trusted);

        Assert.Contains("幻灯片：上下键翻页?", ordinaryText, StringComparison.Ordinal);
        Assert.Contains("map-ppt-init", trustedText, StringComparison.Ordinal);
        Assert.Contains("map-ppt-nav", trustedText, StringComparison.Ordinal);
        Assert.Contains("map-ppt-goto", trustedText, StringComparison.Ordinal);
        Assert.Contains("bootFocus", trustedText, StringComparison.Ordinal);
        Assert.Contains("map-slide-nav-bridge-only", trustedText, StringComparison.Ordinal);
        Assert.Contains("decided = true; driver = resolveDriver(); return;", trustedText, StringComparison.Ordinal);
        Assert.Equal(trusted, normalizedAgain);
        Assert.Contains("演示稿导航", trustedText, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishCoordinator_ShouldBackoffAndDeadLetterAfterBoundedFailures()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        const string html = "<!doctype html><html><body>retry</body></html>";
        var hash = MdToPptController.ComputeHtmlHash(html);
        var run = Run("publish-dead-letter", "convert", "done", html, hash);
        await fixture.Db.MdToPptRuns.InsertOneAsync(run);

        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetTeamsNotPublishableAsync(
                run.UserId,
                It.IsAny<IReadOnlyCollection<string>>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync([]);
        sites.Setup(service => service.CreateFromHtmlIdempotentAsync(
                It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<string?>(),
                It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<List<string>?>(),
                It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("private provider detail"));
        var coordinator = new HtmlPptPublishCoordinator(
            fixture.Db,
            sites.Object,
            Mock.Of<IHostedSiteRevisionService>(),
            Mock.Of<IHtmlPptDesignArtifactAdapter>(),
            NullLogger<HtmlPptPublishCoordinator>.Instance);

        for (var attempt = 1; attempt <= HtmlPptPublishCoordinator.MaxAttempts; attempt++)
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                coordinator.PublishAsync(run, run.Title, null, [], []));
            var persisted = await fixture.Db.MdToPptRuns.Find(item => item.Id == run.Id).SingleAsync();
            Assert.Equal(attempt, persisted.PublishIntentAttemptCount);
            if (attempt < HtmlPptPublishCoordinator.MaxAttempts)
            {
                Assert.Equal("retry", persisted.PublishIntentStatus);
                Assert.Equal("ppt_publish_failed", persisted.PublishIntentLastFailureCode);
                Assert.NotNull(persisted.PublishIntentNextAttemptAt);
                await fixture.Db.MdToPptRuns.UpdateOneAsync(
                    item => item.Id == run.Id,
                    Builders<MdToPptRun>.Update.Set(
                        item => item.PublishIntentNextAttemptAt,
                        DateTime.UtcNow.AddSeconds(-1)));
            }
        }

        var deadLetter = await fixture.Db.MdToPptRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal("dead-letter", deadLetter.PublishIntentStatus);
        Assert.Equal(HtmlPptPublishCoordinator.DeadLetterCode, deadLetter.PublishIntentLastFailureCode);
        Assert.Null(deadLetter.PublishIntentNextAttemptAt);
        Assert.DoesNotContain("private provider detail", deadLetter.PublishIntentLastFailureCode, StringComparison.Ordinal);
        var stopped = await Assert.ThrowsAsync<HtmlPptPublishPendingException>(() =>
            coordinator.PublishAsync(run, run.Title, null, [], []));
        Assert.Equal(HtmlPptPublishCoordinator.DeadLetterCode, stopped.Code);
        sites.Verify(service => service.CreateFromHtmlIdempotentAsync(
            It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<string?>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<List<string>?>(),
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()),
            Times.Exactly(HtmlPptPublishCoordinator.MaxAttempts));
    }

    [Fact]
    public void CreateRun_ShouldCompensateWhenBeginFails()
    {
        // 接线守卫：补偿方法建好了没人调，就等于没建（形状 2）——而删掉那段 catch
        // 不会让上面两条适配器用例变红，它们是直接调的。
        var root = FindRepositoryRoot();
        var controller = File.ReadAllText(Path.Combine(
            root, "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "MdToPptController.cs"));

        var insert = controller.IndexOf(
            "await _db.MdToPptRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);",
            StringComparison.Ordinal);
        Assert.True(insert > 0, "专用任务的落库点不见了，契约可能被挪走了");
        var body = controller[insert..Math.Min(insert + 1600, controller.Length)];

        // companion：确实截到了那一段（它紧接着就 Begin）。
        Assert.Contains("_designArtifactAdapter.BeginAsync(run, CancellationToken.None)", body, StringComparison.Ordinal);
        Assert.True(body.Contains("TryDiscardUnstartedAsync", StringComparison.Ordinal),
            "BeginAsync 失败后没有回滚半成品，它会永远停在 running：恢复流程不收无账本孤儿");
        Assert.True(body.Contains("throw;", StringComparison.Ordinal),
            "补偿不能把原始异常吞掉，调用方必须照样看到失败");
    }

    /// <summary>
    /// 「专用任务已落库、公共账本还没建起来」的半成品谁都不管：恢复流程明确跳过无账本孤儿
    /// （它自己的注释写着「归属仍待明确」），过期判定也要先有账本才轮得到。不收拾的话它
    /// 永远停在 running——而调用方连这个 run 都没拿到（Codex P2，2026-09-16）。
    /// </summary>
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task DiscardUnstarted_ShouldRemoveTheLedgerlessHalfCreatedRun()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        var adapter = Adapter(fixture, new InMemoryRunEventStore());
        var orphan = Run("ledgerless-orphan", "convert", "running", string.Empty, null);
        await fixture.Db.MdToPptRuns.InsertOneAsync(orphan);

        // companion：恢复流程确实不收它——先证明这一点，否则下面的补偿就是多余的。
        Assert.Equal(0, await adapter.RecoverPendingAsync());

        Assert.True(await adapter.TryDiscardUnstartedAsync(orphan));
        Assert.Null(await fixture.Db.MdToPptRuns.Find(item => item.Id == orphan.Id).FirstOrDefaultAsync());
    }

    /// <summary>
    /// 账本已经建出来的那一种不能删：BeginAsync 可能是先建好身份、再在一致性校验上失败的，
    /// 删掉专用任务只会把公共账本变成孤儿，而那一条本来就归恢复流程管。
    /// </summary>
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task DiscardUnstarted_ShouldKeepTheRunOnceThePublicLedgerExists()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        var adapter = Adapter(fixture, new InMemoryRunEventStore());
        var started = Run("ledger-exists", "convert", "running", string.Empty, null);
        await fixture.Db.MdToPptRuns.InsertOneAsync(started);
        await adapter.BeginAsync(started);

        Assert.False(await adapter.TryDiscardUnstartedAsync(started));
        Assert.NotNull(await fixture.Db.MdToPptRuns.Find(item => item.Id == started.Id).FirstOrDefaultAsync());
    }

    private static HtmlPptDesignArtifactAdapter Adapter(AdapterMongoFixture fixture, IRunEventStore events) => new(
        fixture.Db,
        new DesignArtifactLifecycleService(fixture.Db, events),
        NullLogger<HtmlPptDesignArtifactAdapter>.Instance);

    /// <summary>
    /// 收据是历史事实：「这条意图把版本 V 发布到了站点 S」。站点后来又发了新版本把指针顶走，
    /// 不该让重放这次发布再也拿不回收据——恢复器明确不收 completed 意图，那就是永久 503。
    /// </summary>
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishCoordinator_ShouldReplayCompletedReceiptAfterANewerRevisionTookOverTheSite()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        const string html = "<!doctype html><html><head></head><body>superseded receipt</body></html>";
        var hash = MdToPptController.ComputeHtmlHash(html);
        var run = Run("publish-superseded", "convert", "done", html, hash);
        var intentId = HtmlPptPublishCoordinator.BuildIntentId(run.Id, hash);
        var publishedAt = new DateTime(2026, 9, 8, 2, 3, 4, DateTimeKind.Utc);
        run.PublishIntentId = intentId;
        run.PublishIntentStatus = "completed";
        run.PublishIntentHtmlHash = hash;
        run.PublishIntentCompletedAt = publishedAt;
        run.PublishedSiteId = "superseded-site";
        run.PublishedVersionId = "revision-v1";
        run.PublishedHtmlHash = hash;
        await fixture.Db.MdToPptRuns.InsertOneAsync(run);

        // 站点已经被后来的一次发布推进：当前指针是 v2，ContentVersion 也跟着走了。
        await fixture.Db.HostedSites.InsertOneAsync(new HostedSite
        {
            Id = "superseded-site",
            OwnerUserId = run.UserId,
            Title = run.Title,
            SiteUrl = "https://site.invalid/index.html",
            ContentVersion = publishedAt.AddMinutes(30),
            PublishedRevisionId = "revision-v2",
            SourceType = "md-to-ppt",
            SourceRef = intentId,
        });
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(new HostedSiteRevision
        {
            Id = "revision-v1",
            SiteId = "superseded-site",
            CreatedByUserId = run.UserId,
            Status = HostedSiteRevisionStatuses.Published,
            Source = HostedSiteRevisionSources.Baseline,
            Runtime = DesignArtifactRuntimes.HtmlPptPipeline,
            SourceRunId = run.Id,
            Html = html,
            BasedOnContentVersion = publishedAt,
            PublishedContentVersion = publishedAt,
            CreatedAt = publishedAt,
            PublishedAt = publishedAt,
        });

        var coordinator = new HtmlPptPublishCoordinator(
            fixture.Db,
            new Mock<IHostedSiteService>(MockBehavior.Strict).Object,
            new Mock<IHostedSiteRevisionService>(MockBehavior.Strict).Object,
            new Mock<IHtmlPptDesignArtifactAdapter>(MockBehavior.Strict).Object,
            NullLogger<HtmlPptPublishCoordinator>.Instance);

        var replayed = await coordinator.PublishAsync(run, run.Title, null, [], []);

        Assert.Equal("revision-v1", replayed.Revision.Id);
        Assert.Equal("superseded-site", replayed.Site.Id);
        Assert.Equal(hash, replayed.ContentHash);
    }

    /// <summary>半落地的版本（还没完成发布）仍然不能当成收据交出去。</summary>
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishCoordinator_ShouldStillWithholdAReceiptWhoseRevisionNeverFinishedPublishing()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        const string html = "<!doctype html><html><head></head><body>half landed</body></html>";
        var hash = MdToPptController.ComputeHtmlHash(html);
        var run = Run("publish-half-landed", "convert", "done", html, hash);
        var intentId = HtmlPptPublishCoordinator.BuildIntentId(run.Id, hash);
        var startedAt = new DateTime(2026, 9, 8, 2, 3, 4, DateTimeKind.Utc);
        run.PublishIntentId = intentId;
        run.PublishIntentStatus = "completed";
        run.PublishIntentHtmlHash = hash;
        run.PublishedSiteId = "half-landed-site";
        run.PublishedVersionId = "revision-pending";
        run.PublishedHtmlHash = hash;
        await fixture.Db.MdToPptRuns.InsertOneAsync(run);

        await fixture.Db.HostedSites.InsertOneAsync(new HostedSite
        {
            Id = "half-landed-site",
            OwnerUserId = run.UserId,
            Title = run.Title,
            SiteUrl = "https://site.invalid/index.html",
            ContentVersion = startedAt,
            SourceType = "md-to-ppt",
            SourceRef = intentId,
        });
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(new HostedSiteRevision
        {
            Id = "revision-pending",
            SiteId = "half-landed-site",
            CreatedByUserId = run.UserId,
            // 还停在 Publishing：版本账本没有完成过一次发布，没有 PublishedContentVersion。
            Status = HostedSiteRevisionStatuses.Publishing,
            Source = HostedSiteRevisionSources.Baseline,
            Runtime = DesignArtifactRuntimes.HtmlPptPipeline,
            SourceRunId = run.Id,
            Html = html,
            BasedOnContentVersion = startedAt,
            CreatedAt = startedAt,
        });

        var coordinator = new HtmlPptPublishCoordinator(
            fixture.Db,
            new Mock<IHostedSiteService>(MockBehavior.Strict).Object,
            new Mock<IHostedSiteRevisionService>(MockBehavior.Strict).Object,
            new Mock<IHtmlPptDesignArtifactAdapter>(MockBehavior.Strict).Object,
            NullLogger<HtmlPptPublishCoordinator>.Instance);

        await Assert.ThrowsAsync<HtmlPptPublishPendingException>(
            () => coordinator.PublishAsync(run, run.Title, null, [], []));
    }

    private static MdToPptRun Run(
        string id,
        string op,
        string status,
        string html,
        string? htmlHash,
        string? parentRunId = null,
        string? parentHtmlHash = null) => new()
    {
        Id = id,
        UserId = "owner-user",
        Status = status,
        Runtime = DesignArtifactRuntimes.HtmlPptPipeline,
        Provider = "open-design-html-ppt",
        ArtifactContractVersion = DesignArtifactContractVersions.Current,
        Op = op,
        Title = "HTML PPT",
        SourceSurface = DesignArtifactSourceSurfaces.HtmlPpt,
        Html = html,
        HtmlHash = htmlHash,
        ParentRunId = parentRunId,
        ParentHtmlHash = parentHtmlHash,
        UpdatedAt = DateTime.UtcNow,
    };

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "prd-api", "src", "PrdAgent.Api", "Program.cs")))
            directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("找不到仓库根目录");
    }

    private sealed class AdapterMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private AdapterMongoFixture(MongoClient client, string connectionString, string suffix)
        {
            _client = client;
            _databaseName = $"html_ppt_adapter_{suffix}";
            Db = new MongoDbContext(connectionString, _databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<AdapterMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new AdapterMongoFixture(client, connectionString, Guid.NewGuid().ToString("N"));
        }

        public async ValueTask DisposeAsync()
        {
            await _client.DropDatabaseAsync(_databaseName);
        }
    }
}
