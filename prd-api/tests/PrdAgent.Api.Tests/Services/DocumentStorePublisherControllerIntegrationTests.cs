using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.DocumentStore;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", "Integration")]
public sealed class DocumentStorePublisherControllerIntegrationTests
{
    [Fact]
    public async Task PublisherFolderFlow_EnforcesOwnerCasNoopAndSameRunRollback()
    {
        await using var fixture = await PublisherMongoFixture.CreateAsync();
        var store = await fixture.InsertStoreAsync("owner-a");
        var controller = fixture.CreateController("owner-a");

        var create = Request("run-a", "权威教程");
        (await controller.PutNode(store.Id, "chapter-root", create, CancellationToken.None))
            .ShouldBeOfType<OkObjectResult>();
        var created = await fixture.Db.DocumentEntries.Find(entry => entry.StoreId == store.Id).SingleAsync();

        var noop = Request("run-a", "权威教程");
        noop.ExpectedUpdatedAt = created.UpdatedAt;
        noop.LastAppliedSha256 = EmptySha;
        (await controller.PutNode(store.Id, "chapter-root", noop, CancellationToken.None))
            .ShouldBeOfType<OkObjectResult>();
        var afterNoop = await fixture.Db.DocumentEntries.Find(entry => entry.Id == created.Id).SingleAsync();
        afterNoop.UpdatedAt.ShouldBe(created.UpdatedAt);
        afterNoop.Metadata[DocumentStorePublisherPolicy.LastAppliedRunIdKey].ShouldBe("run-a");

        var metadataSha = DocumentStorePublisherPolicy.MetadataSha256(afterNoop.Metadata);
        (await controller.DeleteCreatedNode(
                store.Id,
                "chapter-root",
                "publisher-a",
                "run-a",
                afterNoop.UpdatedAt,
                EmptySha,
                metadataSha,
                CancellationToken.None))
            .ShouldBeOfType<OkObjectResult>();
        (await fixture.Db.DocumentEntries.CountDocumentsAsync(entry => entry.StoreId == store.Id)).ShouldBe(0);
    }

    [Fact]
    public async Task PublisherRollback_RejectsNodeUpdatedByLaterRun()
    {
        await using var fixture = await PublisherMongoFixture.CreateAsync();
        var store = await fixture.InsertStoreAsync("owner-a");
        var controller = fixture.CreateController("owner-a");

        (await controller.PutNode(store.Id, "chapter-root", Request("run-a", "初始标题"), CancellationToken.None))
            .ShouldBeOfType<OkObjectResult>();
        var created = await fixture.Db.DocumentEntries.Find(entry => entry.StoreId == store.Id).SingleAsync();

        var update = Request("run-b", "初始标题");
        update.ExpectedUpdatedAt = created.UpdatedAt;
        update.LastAppliedSha256 = EmptySha;
        (await controller.PutNode(store.Id, "chapter-root", update, CancellationToken.None))
            .ShouldBeOfType<OkObjectResult>();
        var updated = await fixture.Db.DocumentEntries.Find(entry => entry.Id == created.Id).SingleAsync();
        updated.UpdatedAt.ShouldBeGreaterThan(created.UpdatedAt);
        updated.Metadata[DocumentStorePublisherPolicy.CreatedByRunIdKey].ShouldBe("run-a");
        updated.Metadata[DocumentStorePublisherPolicy.LastAppliedRunIdKey].ShouldBe("run-b");

        var rollback = await controller.DeleteCreatedNode(
            store.Id,
            "chapter-root",
            "publisher-a",
            "run-a",
            updated.UpdatedAt,
            EmptySha,
            DocumentStorePublisherPolicy.MetadataSha256(updated.Metadata),
            CancellationToken.None);
        rollback.ShouldBeOfType<ObjectResult>().StatusCode.ShouldBe(StatusCodes.Status409Conflict);
        (await fixture.Db.DocumentEntries.CountDocumentsAsync(entry => entry.Id == created.Id)).ShouldBe(1);
    }

    [Fact]
    public async Task PublisherEndpoints_FailClosedForForeignOwnerSpecialStoreAndDuplicateIdentity()
    {
        await using var fixture = await PublisherMongoFixture.CreateAsync();
        var foreign = await fixture.InsertStoreAsync("owner-b");
        var special = await fixture.InsertStoreAsync("owner-a", pmProjectId: "pm-project");
        var generic = await fixture.InsertStoreAsync("owner-a");
        var controller = fixture.CreateController("owner-a");

        (await controller.Snapshot(foreign.Id, "publisher-a", CancellationToken.None))
            .ShouldBeOfType<NotFoundObjectResult>();
        (await controller.Snapshot(special.Id, "publisher-a", CancellationToken.None))
            .ShouldBeOfType<NotFoundObjectResult>();

        await fixture.Db.DocumentEntries.InsertManyAsync(new[]
        {
            ManagedFolder(generic.Id, "duplicate-a", "chapter-00"),
            ManagedFolder(generic.Id, "duplicate-b", "chapter-00"),
        });
        var result = await controller.PutNode(
            generic.Id,
            "chapter-01",
            Request("run-a", "新章节"),
            CancellationToken.None);
        result.ShouldBeOfType<ObjectResult>().StatusCode.ShouldBe(StatusCodes.Status409Conflict);
        (await fixture.Db.DocumentEntries.CountDocumentsAsync(entry => entry.StoreId == generic.Id)).ShouldBe(2);
    }

    private static readonly string EmptySha = DocumentStorePublisherPolicy.Sha256(string.Empty);

    private static PublisherPutNodeRequest Request(string runId, string title)
        => new()
        {
            Publisher = "publisher-a",
            RunId = runId,
            Kind = "folder",
            Title = title,
            SourcePath = "chapters/root",
            SourceSha256 = EmptySha,
            ManifestSha256 = DocumentStorePublisherPolicy.Sha256("manifest"),
            SourceRevision = "revision-1",
        };

    private static DocumentEntry ManagedFolder(string storeId, string id, string sourceId)
        => new()
        {
            Id = id,
            StoreId = storeId,
            IsFolder = true,
            Title = id,
            ContentType = "application/x-folder",
            Metadata = DocumentStorePublisherPolicy.MergeMetadata(
                null,
                null,
                "publisher-a",
                sourceId,
                sourceId,
                EmptySha,
                DocumentStorePublisherPolicy.Sha256("manifest"),
                "revision-1",
                "folder",
                "run-a",
                "run-a"),
        };

    private sealed class PublisherMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private PublisherMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        public MongoDbContext Db { get; }

        public static async Task<PublisherMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(2);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new PublisherMongoFixture(client, connectionString, $"publisher_contract_{Guid.NewGuid():N}");
        }

        public async Task<DocumentStore> InsertStoreAsync(string ownerId, string? pmProjectId = null)
        {
            var store = new DocumentStore
            {
                Name = "发布隔离库",
                OwnerId = ownerId,
                PmProjectId = pmProjectId,
            };
            await Db.DocumentStores.InsertOneAsync(store);
            return store;
        }

        public DocumentStorePublisherController CreateController(string ownerId)
        {
            var controller = new DocumentStorePublisherController(
                Db,
                new Mock<IDocumentService>().Object,
                null!,
                new MentionService(Db));
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        new[] { new Claim("boundUserId", ownerId) },
                        authenticationType: "ApiKey")),
                },
            };
            return controller;
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
