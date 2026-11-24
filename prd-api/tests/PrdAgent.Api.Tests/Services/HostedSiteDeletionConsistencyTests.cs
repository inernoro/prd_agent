using Microsoft.Extensions.Logging.Abstractions;
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

[Trait("Category", TestCategories.Integration)]
public sealed class HostedSiteDeletionConsistencyTests
{
    private const string SiteId = "0123456789abcdef0123456789abcdef";
    private const string UserId = "hosted-site-delete-user";
    private const string ObjectKey = "data/web-hosting/sites/0123456789abcdef0123456789abcdef/index.html";

    [Fact]
    public async Task StorageFailure_ShouldKeepRetryLedgerAndWorkerShouldFinishCleanup()
    {
        await using var fixture = await DeleteMongoFixture.CreateAsync();
        await SeedSiteAsync(fixture.Db);
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.SetupSequence(x => x.DeleteByKeyAsync(ObjectKey, CancellationToken.None))
            .ThrowsAsync(new IOException("synthetic storage outage"))
            .Returns(Task.CompletedTask);
        var service = Build(fixture.Db, storage.Object);

        var pending = await Assert.ThrowsAsync<HostedSiteDeletionPendingException>(
            () => service.DeleteAsync(SiteId, UserId, CancellationToken.None));

        Assert.Equal(SiteId, pending.SiteId);
        Assert.Equal(1, pending.AttemptCount);
        Assert.False(await fixture.Db.HostedSites.Find(x => x.Id == SiteId).AnyAsync());
        var ledger = await fixture.Db.HostedSiteDeletionTasks.Find(x => x.Id == SiteId).SingleAsync();
        Assert.NotNull(ledger.SiteRecordDeletedAt);
        Assert.Equal("asset_cleanup_failed", ledger.LastErrorCode);
        Assert.Equal(1, ledger.AttemptCount);
        Assert.Null(ledger.LeaseOwnerId);

        Assert.True(await service.ResumeNextPendingDeletionAsync(
            DateTime.UtcNow.AddHours(2),
            CancellationToken.None));
        Assert.False(await fixture.Db.HostedSiteDeletionTasks.Find(x => x.Id == SiteId).AnyAsync());
        storage.Verify(
            x => x.DeleteByKeyAsync(ObjectKey, CancellationToken.None),
            Times.Exactly(2));
    }

    [Fact]
    public async Task CrashAfterIntentPersisted_ShouldDeleteRecordBeforeDeletingObject()
    {
        await using var fixture = await DeleteMongoFixture.CreateAsync();
        await SeedSiteAsync(fixture.Db);
        await fixture.Db.HostedSiteDeletionTasks.InsertOneAsync(new HostedSiteDeletionTask
        {
            Id = SiteId,
            SiteId = SiteId,
            SiteOwnerUserId = UserId,
            RequestedByUserId = UserId,
            SiteTitle = "待恢复删除站点",
            ObjectKeys = new List<string> { ObjectKey },
            RequestedAt = DateTime.UtcNow.AddMinutes(-5),
            NextAttemptAt = DateTime.UtcNow.AddMinutes(-5),
        });
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.DeleteByKeyAsync(ObjectKey, CancellationToken.None))
            .Returns(Task.CompletedTask);
        var service = Build(fixture.Db, storage.Object);

        Assert.True(await service.ResumeNextPendingDeletionAsync(ct: CancellationToken.None));

        Assert.False(await fixture.Db.HostedSites.Find(x => x.Id == SiteId).AnyAsync());
        Assert.False(await fixture.Db.HostedSiteDeletionTasks.Find(x => x.Id == SiteId).AnyAsync());
        storage.Verify(x => x.DeleteByKeyAsync(ObjectKey, CancellationToken.None), Times.Once);
    }

    [Fact]
    public async Task ConcurrentRecovery_ShouldOnlyLeaseOneAttempt()
    {
        await using var fixture = await DeleteMongoFixture.CreateAsync();
        await fixture.Db.HostedSiteDeletionTasks.InsertOneAsync(new HostedSiteDeletionTask
        {
            Id = SiteId,
            SiteId = SiteId,
            SiteOwnerUserId = UserId,
            RequestedByUserId = UserId,
            SiteTitle = "并发恢复站点",
            ObjectKeys = new List<string> { ObjectKey },
            RequestedAt = DateTime.UtcNow.AddMinutes(-5),
            SiteRecordDeletedAt = DateTime.UtcNow.AddMinutes(-4),
            NextAttemptAt = DateTime.UtcNow.AddMinutes(-5),
        });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.DeleteByKeyAsync(ObjectKey, CancellationToken.None))
            .Returns(async () =>
            {
                entered.TrySetResult();
                await release.Task;
            });
        var service = Build(fixture.Db, storage.Object);

        var first = service.ResumeNextPendingDeletionAsync(ct: CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var second = await service.ResumeNextPendingDeletionAsync(ct: CancellationToken.None);
        release.TrySetResult();

        Assert.False(second);
        Assert.True(await first);
        storage.Verify(x => x.DeleteByKeyAsync(ObjectKey, CancellationToken.None), Times.Once);
    }

    private static async Task SeedSiteAsync(MongoDbContext db)
    {
        await db.HostedSites.InsertOneAsync(new HostedSite
        {
            Id = SiteId,
            OwnerUserId = UserId,
            Title = "待删除站点",
            Files = new List<HostedSiteFile>
            {
                new() { Path = "index.html", CosKey = ObjectKey, MimeType = "text/html", Size = 10 },
            },
        });
    }

    private static HostedSiteService Build(MongoDbContext db, IAssetStorage storage) =>
        new(
            db,
            storage,
            Mock.Of<IShortLinkService>(),
            Mock.Of<ISharePasswordService>(),
            Mock.Of<ITeamService>(),
            Mock.Of<ITeamActivityService>(),
            Mock.Of<IUploadProgressService>(),
            Mock.Of<IAskOpeningQuestionGenerator>(),
            NullLogger<HostedSiteService>.Instance);

    private sealed class DeleteMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private DeleteMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<DeleteMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27018";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new DeleteMongoFixture(
                client,
                connectionString,
                $"hosted_site_deletion_test_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
