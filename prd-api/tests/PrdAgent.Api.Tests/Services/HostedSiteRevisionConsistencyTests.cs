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
            return new RevisionMongoFixture(client, connectionString, $"hosted_revision_consistency_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
