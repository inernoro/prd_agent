using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class HostedSiteRevisionConsistencyTests
{
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task GeneratedSnapshot_ShouldPersistActualRuntimeRunAndKnowledgeProvenance()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var version = MongoTime(DateTime.UtcNow);
        var site = Site(null, version);
        var entry = new HostedSiteEditableEntry(site, "<!doctype html><html>generated</html>", version);
        var service = new HostedSiteRevisionService(fixture.Db, Mock.Of<IHostedSiteService>());

        var revision = await service.EnsureGeneratedSnapshotAsync(
            site.Id,
            "user-1",
            entry,
            HostedSiteEditRuntimes.OpenDesign,
            "run-open-design",
            ["entry-1", "entry-1", "entry-2"]);

        Assert.Equal(HostedSiteEditRuntimes.OpenDesign, revision.Runtime);
        Assert.Equal("run-open-design", revision.SourceRunId);
        Assert.Equal(["entry-1", "entry-2"], revision.KnowledgeEntryIds);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task Rollback_ShouldRecordManualLedgerActionInsteadOfPretendingToRunAiAgain()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var targetVersion = MongoTime(DateTime.UtcNow.AddMinutes(-2));
        var currentVersion = MongoTime(DateTime.UtcNow.AddMinutes(-1));
        var publishedVersion = MongoTime(DateTime.UtcNow);
        var target = new HostedSiteRevision
        {
            Id = "open-design-target",
            SiteId = "site-1",
            CreatedByUserId = "user-1",
            Status = HostedSiteRevisionStatuses.Published,
            Source = HostedSiteRevisionSources.Baseline,
            Runtime = HostedSiteEditRuntimes.OpenDesign,
            SourceRunId = "run-open-design",
            KnowledgeEntryIds = ["entry-1"],
            Html = "<!doctype html><html>target</html>",
            BasedOnContentVersion = targetVersion,
            PublishedContentVersion = targetVersion,
            PublishedAt = targetVersion,
            CreatedAt = targetVersion,
        };
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(target);
        var currentSite = Site(null, currentVersion);
        var publishedSite = Site(null, publishedVersion);
        var sites = new Mock<IHostedSiteService>();
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(currentSite, "<!doctype html><html>current</html>", currentVersion));
        sites.Setup(x => x.ReplaceEntryHtmlAsync(
                "site-1", "user-1", target.Html, currentVersion, It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(publishedSite);
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        var result = await service.RollbackAsync("site-1", target.Id, "user-1", "rollback-test-0001");

        Assert.Equal(HostedSiteEditRuntimes.Manual, result.Revision.Runtime);
        Assert.Null(result.Revision.SourceRunId);
        Assert.Equal(target.KnowledgeEntryIds, result.Revision.KnowledgeEntryIds);
        Assert.Equal(HostedSiteRevisionSources.Rollback, result.Revision.Source);
        Assert.Equal(target.Id, result.Revision.RollbackTargetRevisionId);
        Assert.True(result.Changed);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task RollbackRetry_WithSameIdempotencyKey_ShouldReuseOneRevision()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-1));
        var publishedVersion = MongoTime(DateTime.UtcNow);
        var target = PublishingRevision("rollback-idempotent-target", baseVersion);
        target.Status = HostedSiteRevisionStatuses.Published;
        target.PublishedAt = baseVersion;
        target.PublishedContentVersion = baseVersion;
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(target);
        var currentSite = Site(target.Id, baseVersion);
        var sites = new Mock<IHostedSiteService>();
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(currentSite, target.Html, baseVersion));
        sites.Setup(x => x.ReplaceEntryHtmlAsync(
                "site-1", "user-1", target.Html, baseVersion, It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(Site(null, publishedVersion));
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        var first = await service.RollbackAsync("site-1", target.Id, "user-1", "same-request-key");
        var second = await service.RollbackAsync("site-1", target.Id, "user-1", "same-request-key");

        Assert.True(first.Changed);
        Assert.False(second.Changed);
        Assert.Equal(first.Revision.Id, second.Revision.Id);
        Assert.Equal(1, await fixture.Db.HostedSiteRevisions.CountDocumentsAsync(item =>
            item.RollbackIdempotencyKey == "same-request-key"));
        sites.Verify(x => x.ReplaceEntryHtmlAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string>(), It.IsAny<DateTime?>(),
            It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ConcurrentRollback_WithSameIdempotencyKey_ShouldCreateAndPublishOneRevision()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-1));
        var target = PublishingRevision("rollback-concurrent-target", baseVersion);
        target.Status = HostedSiteRevisionStatuses.Published;
        target.PublishedAt = baseVersion;
        target.PublishedContentVersion = baseVersion;
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(target);
        var currentSite = Site(target.Id, baseVersion);
        var sites = new Mock<IHostedSiteService>();
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(currentSite, target.Html, baseVersion));
        sites.Setup(x => x.ReplaceEntryHtmlAsync(
                "site-1", "user-1", target.Html, baseVersion, It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((string _, string _, string _, DateTime? _, string? revisionId, CancellationToken _) =>
                Site(revisionId, MongoTime(DateTime.UtcNow)));
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ =>
            service.RollbackAsync("site-1", target.Id, "user-1", "concurrent-request-key")));

        Assert.Single(results, result => result.Changed);
        Assert.Single(results.Select(result => result.Revision.Id).Distinct(StringComparer.Ordinal));
        Assert.Equal(1, await fixture.Db.HostedSiteRevisions.CountDocumentsAsync(item =>
            item.RollbackIdempotencyKey == "concurrent-request-key"));
        sites.Verify(x => x.ReplaceEntryHtmlAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string>(), It.IsAny<DateTime?>(),
            It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishRetry_ShouldFinalizeLedgerWhenSitePointerAlreadySwitched()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-2));
        var publishedVersion = baseVersion.AddMinutes(1);
        var revision = PublishingRevision("revision-applied", baseVersion);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        var site = Site(revision.Id, publishedVersion);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(site, revision.Html, publishedVersion));
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        var result = await service.PublishAsync("site-1", revision.Id, "user-1");

        Assert.Equal(HostedSiteRevisionStatuses.Published, result.Revision.Status);
        Assert.Equal(publishedVersion, result.Revision.PublishedContentVersion);
        Assert.False(result.Changed);
        sites.Verify(
            x => x.ReplaceEntryHtmlAsync(
                It.IsAny<string>(),
                It.IsAny<string>(),
                It.IsAny<string>(),
                It.IsAny<DateTime?>(),
                It.IsAny<string?>(),
                It.IsAny<CancellationToken>()),
            Times.Never);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishRetry_ShouldApplyContentWhenIntentPersistedButSiteWasNotSwitched()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-2));
        var publishedVersion = baseVersion.AddMinutes(1);
        var revision = PublishingRevision("revision-pending", baseVersion);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        var currentSite = Site(null, baseVersion);
        var publishedSite = Site(revision.Id, publishedVersion);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(currentSite, "<!doctype html><html>old</html>", baseVersion));
        sites.Setup(x => x.ReplaceEntryHtmlAsync(
                "site-1",
                "user-1",
                revision.Html,
                baseVersion,
                revision.Id,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(publishedSite);
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        var result = await service.PublishAsync("site-1", revision.Id, "user-1");

        Assert.Equal(HostedSiteRevisionStatuses.Published, result.Revision.Status);
        Assert.Equal(publishedVersion, result.Revision.PublishedContentVersion);
        sites.VerifyAll();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ListingVersions_ShouldRepairPublishingLedgerFromActiveSitePointer()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-2));
        var publishedVersion = baseVersion.AddMinutes(1);
        var revision = PublishingRevision("revision-list-repair", baseVersion);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        var site = Site(revision.Id, publishedVersion);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(site, revision.Html, publishedVersion));
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        var revisions = await service.ListAsync("site-1", "user-1");

        var repaired = Assert.Single(revisions);
        Assert.Equal(HostedSiteRevisionStatuses.Published, repaired.Status);
        Assert.Equal(publishedVersion, repaired.PublishedContentVersion);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishFailureBeforeSiteSwitch_ShouldReturnCurrentAttemptToDraft()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-2));
        var revision = PublishingRevision("revision-upload-failure", baseVersion);
        revision.Status = HostedSiteRevisionStatuses.Draft;
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        var currentSite = Site(null, baseVersion);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(currentSite, "<!doctype html><html>old</html>", baseVersion));
        sites.Setup(x => x.ReplaceEntryHtmlAsync(
                "site-1",
                "user-1",
                revision.Html,
                baseVersion,
                revision.Id,
                It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("对象存储写入失败"));
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.PublishAsync("site-1", revision.Id, "user-1"));

        var persisted = await fixture.Db.HostedSiteRevisions.Find(x => x.Id == revision.Id).FirstAsync();
        Assert.Equal(HostedSiteRevisionStatuses.Draft, persisted.Status);
        Assert.Null(persisted.PublishAttemptId);
        Assert.Null(persisted.PublishAttemptStartedAt);
        Assert.Equal("publish_failed", persisted.LastPublishFailureCode);
        Assert.NotNull(persisted.LastPublishFailedAt);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task RollbackPublishFailure_ShouldPersistOnlyStableFailureEvidence()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-2));
        var target = PublishingRevision("revision-rollback-target", baseVersion);
        target.Status = HostedSiteRevisionStatuses.Published;
        target.PublishedContentVersion = baseVersion;
        target.PublishedAt = baseVersion;
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(target);
        var currentSite = Site(target.Id, baseVersion);
        var currentEntry = new HostedSiteEditableEntry(currentSite, target.Html, baseVersion);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(currentEntry);
        sites.Setup(x => x.ReplaceEntryHtmlAsync(
                "site-1",
                "user-1",
                target.Html,
                baseVersion,
                It.IsAny<string?>(),
                It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("secret=must-not-be-persisted"));
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.RollbackAsync("site-1", target.Id, "user-1", "rollback-test-0002"));

        var rollback = await fixture.Db.HostedSiteRevisions
            .Find(item => item.Source == HostedSiteRevisionSources.Rollback)
            .SingleAsync();
        Assert.Equal(HostedSiteRevisionStatuses.Draft, rollback.Status);
        Assert.Equal(target.Id, rollback.RollbackTargetRevisionId);
        Assert.Equal("rollback_publish_failed", rollback.LastPublishFailureCode);
        Assert.NotNull(rollback.LastPublishFailedAt);
        Assert.DoesNotContain("secret", rollback.ToJson(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task LostResponseAfterSiteSwitch_ShouldFinalizeInsteadOfRollingBackAttempt()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-2));
        var publishedVersion = baseVersion.AddMinutes(1);
        var revision = PublishingRevision("revision-lost-response", baseVersion);
        revision.Status = HostedSiteRevisionStatuses.Draft;
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        var currentSite = Site(null, baseVersion);
        var appliedSite = Site(revision.Id, publishedVersion);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.SetupSequence(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(currentSite, "<!doctype html><html>old</html>", baseVersion))
            .ReturnsAsync(new HostedSiteEditableEntry(currentSite, "<!doctype html><html>old</html>", baseVersion))
            .ReturnsAsync(new HostedSiteEditableEntry(appliedSite, revision.Html, publishedVersion));
        sites.Setup(x => x.ReplaceEntryHtmlAsync(
                "site-1",
                "user-1",
                revision.Html,
                baseVersion,
                revision.Id,
                It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("站点写入成功但响应中断"));
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        var result = await service.PublishAsync("site-1", revision.Id, "user-1");

        Assert.Equal(HostedSiteRevisionStatuses.Published, result.Revision.Status);
        Assert.Equal(publishedVersion, result.Revision.PublishedContentVersion);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task FreshPublishingAttempt_ShouldNotBeTakenOverByConcurrentRequest()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-2));
        var revision = PublishingRevision("revision-in-flight", baseVersion);
        revision.PublishAttemptId = "active-attempt";
        revision.PublishAttemptStartedAt = MongoTime(DateTime.UtcNow);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        var currentSite = Site(null, baseVersion);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(currentSite, "<!doctype html><html>old</html>", baseVersion));
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.PublishAsync("site-1", revision.Id, "user-1"));

        Assert.Contains("另一个请求", error.Message);
        var persisted = await fixture.Db.HostedSiteRevisions.Find(x => x.Id == revision.Id).FirstAsync();
        Assert.Equal(HostedSiteRevisionStatuses.Publishing, persisted.Status);
        Assert.Equal("active-attempt", persisted.PublishAttemptId);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task OldAttemptCleanup_ShouldNotUnlockNewPublishingAttempt()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-2));
        var revision = PublishingRevision("revision-attempt-fence", baseVersion);
        revision.PublishAttemptId = "new-attempt";
        revision.PublishAttemptStartedAt = MongoTime(DateTime.UtcNow);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);

        Assert.False(await HostedSiteRevisionService.TryResetPublishingAttemptAsync(
            fixture.Db,
            revision.Id,
            "old-attempt",
            CancellationToken.None));

        var persisted = await fixture.Db.HostedSiteRevisions.Find(x => x.Id == revision.Id).FirstAsync();
        Assert.Equal(HostedSiteRevisionStatuses.Publishing, persisted.Status);
        Assert.Equal("new-attempt", persisted.PublishAttemptId);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task OldAttemptFinalize_ShouldNotFinalizeNewPublishingAttempt()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-2));
        var revision = PublishingRevision("revision-finalize-fence", baseVersion);
        revision.PublishAttemptId = "new-attempt";
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        var service = new HostedSiteRevisionService(fixture.Db, Mock.Of<IHostedSiteService>());

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.FinalizePublishedRevisionAsync(revision, baseVersion.AddMinutes(1), "old-attempt"));

        var persisted = await fixture.Db.HostedSiteRevisions.Find(item => item.Id == revision.Id).SingleAsync();
        Assert.Equal(HostedSiteRevisionStatuses.Publishing, persisted.Status);
        Assert.Equal("new-attempt", persisted.PublishAttemptId);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task RejectDraft_ShouldPersistBoundedRedactedAuditAndBeIdempotent()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-1));
        var revision = PublishingRevision("revision-reject", baseVersion);
        revision.Status = HostedSiteRevisionStatuses.Draft;
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        var site = Site(null, baseVersion);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(site, "<!doctype html><html>old</html>", baseVersion));
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        var first = await service.RejectAsync(
            "site-1",
            revision.Id,
            "user-1",
            " 版式不符合要求\nAuthorization: Bearer secret-token ");
        var second = await service.RejectAsync(
            "site-1",
            revision.Id,
            "user-1",
            "第二次调用不应覆盖原始原因");

        Assert.True(first.Changed);
        Assert.False(second.Changed);
        Assert.Equal(HostedSiteRevisionStatuses.Rejected, second.Revision.Status);
        Assert.NotNull(second.Revision.RejectedAt);
        Assert.Equal("user-1", second.Revision.RejectedByUserId);
        Assert.Equal("版式不符合要求 Authorization=***", second.Revision.RejectionReason);
        Assert.DoesNotContain("secret-token", second.Revision.RejectionReason, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ConcurrentRejects_ShouldHaveExactlyOneStateChange()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-1));
        var revision = PublishingRevision("revision-concurrent-reject", baseVersion);
        revision.Status = HostedSiteRevisionStatuses.Draft;
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        var site = Site(null, baseVersion);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(site, "<!doctype html><html>old</html>", baseVersion));
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(index =>
            service.RejectAsync("site-1", revision.Id, "user-1", $"reason-{index}")));

        Assert.Single(results, result => result.Changed);
        Assert.All(results, result => Assert.Equal(HostedSiteRevisionStatuses.Rejected, result.Revision.Status));
        var persisted = await fixture.Db.HostedSiteRevisions.Find(x => x.Id == revision.Id).SingleAsync();
        Assert.Equal(HostedSiteRevisionStatuses.Rejected, persisted.Status);
        Assert.NotNull(persisted.RejectedAt);
        Assert.Equal("user-1", persisted.RejectedByUserId);
    }

    [Theory]
    [InlineData(HostedSiteRevisionStatuses.Publishing)]
    [InlineData(HostedSiteRevisionStatuses.Published)]
    [Trait("Category", TestCategories.Integration)]
    public async Task RejectNonDraft_ShouldNotChangeRevision(string status)
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-1));
        var revision = PublishingRevision($"revision-reject-{status}", baseVersion);
        revision.Status = status;
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        var site = Site(null, baseVersion);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(site, "<!doctype html><html>old</html>", baseVersion));
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.RejectAsync("site-1", revision.Id, "user-1", null));

        var persisted = await fixture.Db.HostedSiteRevisions.Find(x => x.Id == revision.Id).FirstAsync();
        Assert.Equal(status, persisted.Status);
        Assert.Null(persisted.RejectedAt);
        Assert.Null(persisted.RejectedByUserId);
        Assert.Null(persisted.RejectionReason);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task RejectedRevision_ShouldNotBePublishable()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-1));
        var revision = PublishingRevision("revision-rejected-publish", baseVersion);
        revision.Status = HostedSiteRevisionStatuses.Rejected;
        revision.RejectedAt = baseVersion;
        revision.RejectedByUserId = "user-1";
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(revision);
        var site = Site(null, baseVersion);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(site, "<!doctype html><html>old</html>", baseVersion));
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.PublishAsync("site-1", revision.Id, "user-1"));

        sites.Verify(
            x => x.ReplaceEntryHtmlAsync(
                It.IsAny<string>(),
                It.IsAny<string>(),
                It.IsAny<string>(),
                It.IsAny<DateTime?>(),
                It.IsAny<string?>(),
                It.IsAny<CancellationToken>()),
            Times.Never);
    }

    private static HostedSiteRevision PublishingRevision(string id, DateTime baseVersion) => new()
    {
        Id = id,
        SiteId = "site-1",
        CreatedByUserId = "user-1",
        Status = HostedSiteRevisionStatuses.Publishing,
        Html = "<!doctype html><html>new</html>",
        BasedOnContentVersion = baseVersion,
        CreatedAt = baseVersion,
    };

    private static HostedSite Site(string? revisionId, DateTime contentVersion) => new()
    {
        Id = "site-1",
        OwnerUserId = "user-1",
        EntryFile = "index.html",
        ContentVersion = contentVersion,
        PublishedRevisionId = revisionId,
    };

    private static DateTime MongoTime(DateTime value) =>
        new(value.Ticks - value.Ticks % TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);

    private sealed class RevisionMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private RevisionMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<RevisionMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            var fixture = new RevisionMongoFixture(
                client,
                connectionString,
                $"hosted_revision_consistency_{Guid.NewGuid():N}");
            await fixture.Db.HostedSiteRevisions.Indexes.CreateOneAsync(
                new CreateIndexModel<HostedSiteRevision>(
                    Builders<HostedSiteRevision>.IndexKeys
                        .Ascending(item => item.SiteId)
                        .Ascending(item => item.CreatedByUserId)
                        .Ascending(item => item.RollbackIdempotencyKey),
                    new CreateIndexOptions<HostedSiteRevision>
                    {
                        Name = "uniq_hosted_site_revision_rollback_idempotency",
                        Unique = true,
                        PartialFilterExpression = new BsonDocument(
                            nameof(HostedSiteRevision.RollbackIdempotencyKey),
                            new BsonDocument("$type", "string")),
                    }));
            return fixture;
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
