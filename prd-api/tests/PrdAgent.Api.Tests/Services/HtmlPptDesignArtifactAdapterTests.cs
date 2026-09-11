using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.MdToPpt;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class HtmlPptDesignArtifactAdapterTests
{
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
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishCoordinator_ShouldBackoffAndDeadLetterAfterBoundedFailures()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        const string html = "<!doctype html><html><body>retry</body></html>";
        var hash = MdToPptController.ComputeHtmlHash(html);
        var run = Run("publish-dead-letter", "convert", "done", html, hash);
        await fixture.Db.MdToPptRuns.InsertOneAsync(run);

        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
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

    private static HtmlPptDesignArtifactAdapter Adapter(AdapterMongoFixture fixture, IRunEventStore events) => new(
        fixture.Db,
        new DesignArtifactLifecycleService(fixture.Db, events),
        NullLogger<HtmlPptDesignArtifactAdapter>.Instance);

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
