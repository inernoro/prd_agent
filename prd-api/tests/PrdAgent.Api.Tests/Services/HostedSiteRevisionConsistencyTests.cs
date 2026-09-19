using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
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
    public async Task GeneratedSnapshot_ShouldClaimCompatibleOrdinaryBaselineIdempotently()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var version = MongoTime(DateTime.UtcNow);
        var site = Site(null, version);
        const string html = "<!doctype html><html>html-ppt</html>";
        var entry = new HostedSiteEditableEntry(site, html, version);
        var service = new HostedSiteRevisionService(fixture.Db, Mock.Of<IHostedSiteService>());
        var ordinary = await service.EnsureCurrentSnapshotAsync(site.Id, site.OwnerUserId, entry);

        var claimed = await service.EnsureGeneratedSnapshotAsync(
            site.Id,
            site.OwnerUserId,
            entry,
            DesignArtifactRuntimes.HtmlPptPipeline,
            "ppt-run-1",
            ["knowledge-1"]);
        var retry = await service.EnsureGeneratedSnapshotAsync(
            site.Id,
            site.OwnerUserId,
            entry,
            DesignArtifactRuntimes.HtmlPptPipeline,
            "ppt-run-1",
            ["knowledge-1"]);

        Assert.Equal(ordinary.Id, claimed.Id);
        Assert.Equal(claimed.Id, retry.Id);
        Assert.Equal("ppt-run-1", claimed.SourceRunId);
        Assert.Equal(DesignArtifactRuntimes.HtmlPptPipeline, claimed.Runtime);
        Assert.Equal(["knowledge-1"], claimed.KnowledgeEntryIds);
        Assert.Equal(1, await fixture.Db.HostedSiteRevisions.CountDocumentsAsync(_ => true));
    }

    /// <summary>
    /// 认领基线时该拒的是「内容对不上」与「已经归属别的任务」。
    ///
    /// 原本还有一个 other-owner 变体，逐字要求「创建者不是调用方就拒」——那正是本轮复审
    /// 报出来的缺陷本身：站点主人建完基线，团队编辑者就再也认领不到（形状 4a，反向锁死住
    /// 缺陷的断言）。换成 other-site：基线属于**另一个站点**才是真正该拒的越界。
    /// 调用方有没有权限动这个站点，在拿 entry 时就由 CanEditSiteAsync 判过了。
    /// </summary>
    [Theory]
    [InlineData("other-site")]
    [InlineData("different-hash")]
    [InlineData("other-source-run")]
    [Trait("Category", TestCategories.Integration)]
    public async Task GeneratedSnapshot_ShouldRejectUntrustedBaselineClaim(string mutation)
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var version = MongoTime(DateTime.UtcNow);
        var site = Site(null, version);
        const string html = "<!doctype html><html>html-ppt</html>";
        var entry = new HostedSiteEditableEntry(site, html, version);
        var service = new HostedSiteRevisionService(fixture.Db, Mock.Of<IHostedSiteService>());
        var ordinary = await service.EnsureCurrentSnapshotAsync(site.Id, site.OwnerUserId, entry);
        var update = mutation switch
        {
            "other-site" => Builders<HostedSiteRevision>.Update.Set(item => item.SiteId, "another-site"),
            "different-hash" => Builders<HostedSiteRevision>.Update.Set(
                item => item.Html,
                "<!doctype html><html>different</html>"),
            "other-source-run" => Builders<HostedSiteRevision>.Update
                .Set(item => item.SourceRunId, "another-run")
                .Set(item => item.Runtime, DesignArtifactRuntimes.HtmlPptPipeline),
            _ => throw new InvalidOperationException("未知测试变体"),
        };
        await fixture.Db.HostedSiteRevisions.UpdateOneAsync(item => item.Id == ordinary.Id, update);

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.EnsureGeneratedSnapshotAsync(
            site.Id,
            site.OwnerUserId,
            entry,
            DesignArtifactRuntimes.HtmlPptPipeline,
            "ppt-run-1",
            ["knowledge-1"]));

        var persisted = await fixture.Db.HostedSiteRevisions.Find(item => item.Id == ordinary.Id).SingleAsync();
        Assert.NotEqual("ppt-run-1", persisted.SourceRunId);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task GeneratedVerifiedSnapshot_ShouldClaimExistingMultiFileSiteBaselineWithVerifiedBytes()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var version = MongoTime(DateTime.UtcNow);
        const string runId = "run-multi-file";
        const string html = "<!doctype html><html><link rel=\"stylesheet\" href=\"assets/site.css\"></html>";
        var files = VerifiedFiles(html);
        var site = MultiFileSite(version, runId, files);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(MultiFileRun(runId));
        await fixture.Db.HostedSites.InsertOneAsync(site);
        var entry = new HostedSiteEditableEntry(site, html, version);
        var storage = StorageFor(files, site.Files);
        var service = new HostedSiteRevisionService(
            fixture.Db,
            Mock.Of<IHostedSiteService>(),
            storage.Object);
        var ordinary = await service.EnsureCurrentSnapshotAsync(site.Id, site.OwnerUserId, entry);

        var claimed = await service.EnsureGeneratedVerifiedSnapshotAsync(
            site.Id,
            site.OwnerUserId,
            entry,
            files,
            DesignArtifactRuntimes.OpenDesign,
            runId,
            ["knowledge-1"]);
        var retry = await service.EnsureGeneratedVerifiedSnapshotAsync(
            site.Id,
            site.OwnerUserId,
            entry,
            files,
            DesignArtifactRuntimes.OpenDesign,
            runId,
            ["knowledge-1"]);

        Assert.Equal(ordinary.Id, claimed.Id);
        Assert.Equal(claimed.Id, retry.Id);
        Assert.Equal(runId, claimed.SourceRunId);
        Assert.Equal(files.Select(file => file.Path), claimed.VerifiedFiles.Select(file => file.Path));
        Assert.All(claimed.VerifiedFiles, file => Assert.NotEmpty(file.Content));
        Assert.Equal(1, await fixture.Db.HostedSiteRevisions.CountDocumentsAsync(_ => true));
        storage.Verify(
            item => item.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()),
            Times.Exactly(files.Count));
    }

    [Theory]
    [InlineData("other-run")]
    [InlineData("other-owner")]
    [InlineData("different-object-hash")]
    [InlineData("missing-file")]
    [Trait("Category", TestCategories.Integration)]
    public async Task GeneratedVerifiedSnapshot_ShouldRejectUntrustedMultiFileSiteClaim(string mutation)
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var version = MongoTime(DateTime.UtcNow);
        const string runId = "run-multi-file";
        const string html = "<!doctype html><html><link rel=\"stylesheet\" href=\"assets/site.css\"></html>";
        var files = VerifiedFiles(html);
        var site = MultiFileSite(version, runId, files);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(MultiFileRun(runId));
        await fixture.Db.HostedSites.InsertOneAsync(site);
        var entry = new HostedSiteEditableEntry(site, html, version);
        var storage = StorageFor(files, site.Files);
        var service = new HostedSiteRevisionService(
            fixture.Db,
            Mock.Of<IHostedSiteService>(),
            storage.Object);
        var ordinary = await service.EnsureCurrentSnapshotAsync(site.Id, site.OwnerUserId, entry);

        if (mutation == "other-run")
            await fixture.Db.HostedSites.UpdateOneAsync(
                item => item.Id == site.Id,
                Builders<HostedSite>.Update.Set(item => item.SourceRef, "another-run"));
        else if (mutation == "other-owner")
            await fixture.Db.HostedSites.UpdateOneAsync(
                item => item.Id == site.Id,
                Builders<HostedSite>.Update.Set(item => item.OwnerUserId, "other-user"));
        else if (mutation == "different-object-hash")
            storage.Setup(item => item.TryDownloadBytesAsync(
                    site.Files[1].CosKey,
                    It.IsAny<CancellationToken>()))
                .ReturnsAsync("tampered"u8.ToArray());
        else if (mutation == "missing-file")
            await fixture.Db.HostedSites.UpdateOneAsync(
                item => item.Id == site.Id,
                Builders<HostedSite>.Update.PopLast(item => item.Files));

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.EnsureGeneratedVerifiedSnapshotAsync(
                site.Id,
                site.OwnerUserId,
                entry,
                files,
                DesignArtifactRuntimes.OpenDesign,
                runId,
                ["knowledge-1"]));

        var persisted = await fixture.Db.HostedSiteRevisions.Find(item => item.Id == ordinary.Id).SingleAsync();
        Assert.Null(persisted.SourceRunId);
        Assert.Empty(persisted.VerifiedFiles);
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

    /// <summary>
    /// 进程在「标成 Publishing」之后、「切换站点指针」之前停掉，同一幂等键重试必须能救回来
    /// （Codex P2，2026-09-15）。
    ///
    /// 此前重放循环要求「Publishing 且站点指针已指向它」才交给 PublishAsync，而这种崩法下
    /// 指针永远对不上：PublishAsync 自己那条按 PublishAttemptTtl 接管过期尝试的路径，
    /// 在这里被筛掉了，40 轮全部空转，这条回退记录对回退接口永久失效。
    /// </summary>
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task RollbackRetry_AfterAStalledPublishingAttempt_ShouldTakeOverAndFinish()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var baseVersion = MongoTime(DateTime.UtcNow.AddMinutes(-10));
        var publishedVersion = MongoTime(DateTime.UtcNow);
        var target = PublishingRevision("stalled-rollback-target", baseVersion);
        target.Status = HostedSiteRevisionStatuses.Published;
        target.PublishedAt = baseVersion;
        target.PublishedContentVersion = baseVersion;
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(target);

        // 上一次调用留下的半成品：状态是 Publishing，尝试戳记早已超过 TTL，站点指针还没切过去。
        var stalled = PublishingRevision("stalled-rollback-attempt", baseVersion);
        stalled.Source = HostedSiteRevisionSources.Rollback;
        stalled.RollbackTargetRevisionId = target.Id;
        stalled.RollbackIdempotencyKey = "stalled-request-key";
        stalled.Html = target.Html;
        stalled.PublishAttemptId = "attempt-gone";
        stalled.PublishAttemptStartedAt =
            MongoTime(DateTime.UtcNow - HostedSiteRevisionService.PublishAttemptTtl - TimeSpan.FromMinutes(1));
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(stalled);

        var currentSite = Site(target.Id, baseVersion);
        var sites = new Mock<IHostedSiteService>();
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(currentSite, target.Html, baseVersion));
        sites.Setup(x => x.ReplaceEntryHtmlAsync(
                "site-1", "user-1", target.Html, baseVersion, It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(Site(null, publishedVersion));
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        var recovered = await service.RollbackAsync("site-1", target.Id, "user-1", "stalled-request-key");

        Assert.Equal(stalled.Id, recovered.Revision.Id);
        Assert.Equal(HostedSiteRevisionStatuses.Published, recovered.Revision.Status);
        // companion：确实复用了那条半成品，没有新建第二条回退版本。
        Assert.Equal(1, await fixture.Db.HostedSiteRevisions.CountDocumentsAsync(item =>
            item.RollbackIdempotencyKey == "stalled-request-key"));
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

    private static List<HostedSiteVerifiedFile> VerifiedFiles(string html)
    {
        var index = System.Text.Encoding.UTF8.GetBytes(html);
        var css = "body{color:#111}"u8.ToArray();
        return
        [
            new HostedSiteVerifiedFile("index.html", index, Sha256(index), "text/html; charset=utf-8"),
            new HostedSiteVerifiedFile("assets/site.css", css, Sha256(css), "text/css; charset=utf-8"),
        ];
    }

    private static HostedSite MultiFileSite(
        DateTime contentVersion,
        string sourceRunId,
        IReadOnlyList<HostedSiteVerifiedFile> files)
    {
        var site = Site(null, contentVersion);
        site.SourceType = "design-agent";
        site.SourceRef = sourceRunId;
        site.Files = files.Select((file, index) => new HostedSiteFile
        {
            Path = file.Path,
            CosKey = $"sites/site-1/generated/{index}/{file.Path}",
            Size = file.Content.LongLength,
            MimeType = file.MimeType,
        }).ToList();
        site.TotalSize = site.Files.Sum(file => file.Size);
        return site;
    }

    private static DesignArtifactRun MultiFileRun(string runId) => new()
    {
        Id = runId,
        UserId = "user-1",
        Runtime = DesignArtifactRuntimes.OpenDesign,
        ArtifactType = DesignArtifactTypes.WebPage,
        Operation = DesignArtifactOperations.Generate,
        Status = RunStatuses.Committing,
    };

    private static Mock<IAssetStorage> StorageFor(
        IReadOnlyList<HostedSiteVerifiedFile> files,
        IReadOnlyList<HostedSiteFile> hostedFiles)
    {
        var storage = new Mock<IAssetStorage>();
        foreach (var pair in hostedFiles.Zip(files))
        {
            var bytes = pair.Second.Content.ToArray();
            storage.Setup(item => item.TryDownloadBytesAsync(
                    pair.First.CosKey,
                    It.IsAny<CancellationToken>()))
                .ReturnsAsync(bytes);
        }
        return storage;
    }

    private static string Sha256(byte[] content) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(content)).ToLowerInvariant();

    /// <summary>
    /// 建基线时要记下线上站点当时的形态，回退才拦得住「还原不出来」的那种版本。
    /// 判据建好了没人调用，是本仓库反复栽过的形状；这条钉住它真的被写进库里、也真的拦住回退。
    /// </summary>
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task MultiFileBaseline_ShouldRecordItsShapeAndRefuseAnUnfaithfulRollback()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var version = MongoTime(DateTime.UtcNow);
        var site = Site(null, version);
        site.Files =
        [
            new HostedSiteFile { Path = "index.html", CosKey = "k/index.html", MimeType = "text/html" },
            new HostedSiteFile { Path = "styles/site.css", CosKey = "k/styles/site.css", MimeType = "text/css" },
        ];
        var entry = new HostedSiteEditableEntry(site, "<!doctype html><html>multi</html>", version);
        var sites = new Mock<IHostedSiteService>();
        sites.Setup(service => service.GetEditableEntryHtmlAsync(site.Id, "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(entry);
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        var baseline = await service.EnsureCurrentSnapshotAsync(site.Id, "user-1", entry);

        Assert.Equal(HostedSiteContentShapes.MultiFile, baseline.CapturedContentShape);
        Assert.Empty(baseline.VerifiedFiles);

        var refused = await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.RollbackAsync(site.Id, baseline.Id, "user-1", "rollback-key-1"));
        Assert.Contains("只留下了入口 HTML", refused.Message);

        // 拦住之后不许留下半条回退草稿。
        var drafts = await fixture.Db.HostedSiteRevisions
            .Find(item => item.SiteId == site.Id && item.Source == HostedSiteRevisionSources.Rollback)
            .ToListAsync();
        Assert.Empty(drafts);
    }

    /// <summary>
    /// 基线是站点这一版的事实，不是「谁先把它建出来的」。站点主人打开一次版本历史建了基线之后，
    /// 团队编辑者再发起 AI 微调，曾经会在**模型跑完之后**被按创建者比对拒掉——任务判失败、
    /// 草稿存不下来（Codex P2，2026-09-15）。
    /// </summary>
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ATeamEditorCanClaimTheBaselineAnotherEditorCreated()
    {
        await using var fixture = await RevisionMongoFixture.CreateAsync();
        var version = MongoTime(DateTime.UtcNow);
        var site = Site(null, version);
        const string html = "<!doctype html><html>collaborative</html>";
        var entry = new HostedSiteEditableEntry(site, html, version);
        var service = new HostedSiteRevisionService(fixture.Db, Mock.Of<IHostedSiteService>());

        // 站点主人先打开版本历史，建下基线。
        var baseline = await service.EnsureCurrentSnapshotAsync(site.Id, "user-1", entry);
        Assert.Equal("user-1", baseline.CreatedByUserId);

        // 另一位有编辑权的团队成员发起 AI 微调，落到同一条基线上。
        var claimed = await service.EnsureGeneratedSnapshotAsync(
            site.Id,
            "teammate-2",
            entry,
            HostedSiteEditRuntimes.OpenDesign,
            "run-teammate",
            []);

        Assert.Equal(baseline.Id, claimed.Id);
        Assert.Equal("run-teammate", claimed.SourceRunId);
        Assert.Equal(HostedSiteEditRuntimes.OpenDesign, claimed.Runtime);
        var persisted = await fixture.Db.HostedSiteRevisions
            .Find(item => item.Id == baseline.Id).SingleAsync();
        Assert.Equal("run-teammate", persisted.SourceRunId);
    }

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
