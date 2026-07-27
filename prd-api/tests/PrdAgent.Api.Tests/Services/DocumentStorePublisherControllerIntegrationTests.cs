using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.DocumentStore;
using Shouldly;
using System.Security.Cryptography;
using System.Text;
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
        updated.UpdatedAt.ShouldBe(created.UpdatedAt);
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

    [Fact]
    public async Task PublisherDocumentFlow_SecondWriteIsNoopAndManualDriftConflictsWithoutOverwrite()
    {
        await using var fixture = await PublisherMongoFixture.CreateAsync();
        var store = await fixture.InsertStoreAsync("owner-a");
        var controller = fixture.CreateController("owner-a");
        const string content = "# 第 0 章\n\n[[第 1 章：什么是模型网关]]";

        var create = DocumentRequest("run-a", "第 0 章：这本书怎么用", content);
        (await controller.PutNode(store.Id, "chapter-00", create, CancellationToken.None))
            .ShouldBeOfType<OkObjectResult>();
        var created = await fixture.Db.DocumentEntries.Find(entry => entry.StoreId == store.Id).SingleAsync();
        created.Metadata[DocumentStorePublisherPolicy.DerivedStateKey].ShouldBe("ready");

        var noop = DocumentRequest("run-b", "第 0 章：这本书怎么用", content);
        noop.ExpectedUpdatedAt = created.UpdatedAt;
        noop.LastAppliedSha256 = DocumentStorePublisherPolicy.Sha256(content);
        (await controller.PutNode(store.Id, "chapter-00", noop, CancellationToken.None))
            .ShouldBeOfType<OkObjectResult>();
        var afterNoop = await fixture.Db.DocumentEntries.Find(entry => entry.Id == created.Id).SingleAsync();
        afterNoop.UpdatedAt.ShouldBe(created.UpdatedAt);

        await fixture.ReplaceDocumentContentAsync(afterNoop.DocumentId!, content + "\n\n人工修订");
        var conflict = DocumentRequest("run-c", "第 0 章：这本书怎么用", content);
        conflict.ExpectedUpdatedAt = afterNoop.UpdatedAt;
        conflict.LastAppliedSha256 = DocumentStorePublisherPolicy.Sha256(content);
        var result = await controller.PutNode(store.Id, "chapter-00", conflict, CancellationToken.None);
        result.ShouldBeOfType<ObjectResult>().StatusCode.ShouldBe(StatusCodes.Status409Conflict);
        (await fixture.ReadDocumentContentAsync(afterNoop.DocumentId!)).ShouldBe(content + "\n\n人工修订");
    }

    [Fact]
    public async Task TutorialLinkGraph_PublishIsCasProtectedAndRollbackCreatesHistory()
    {
        await using var fixture = await PublisherMongoFixture.CreateAsync();
        var store = await fixture.InsertStoreAsync("owner-a");
        await fixture.Db.DocumentEntries.InsertOneAsync(ManagedDocument(store.Id, "tutorial-a", "chapter-00"));
        var service = new TutorialLinkGraphService(fixture.Db);

        var initial = Graph("revision-1", DateTime.UtcNow);
        var draft = await service.SaveDraftAsync(
            store.Id,
            "publisher-a",
            initial,
            null,
            "owner-a",
            CancellationToken.None);
        draft.Status.ShouldBe(TutorialLinkGraphMutationStatus.Success);
        draft.Graph!.Draft!.Generator.ShouldBe("llmgw-tutorial-publisher");
        var firstSha = draft.Graph!.Draft!.GraphSha256;

        var published = await service.PublishAsync(
            store.Id,
            "publisher-a",
            firstSha,
            null,
            "owner-a",
            CancellationToken.None);
        published.Status.ShouldBe(TutorialLinkGraphMutationStatus.Success);
        published.Graph!.Versions.Count.ShouldBe(1);
        var firstVersionId = published.Graph.Versions.Single().VersionId;

        var changed = Graph("revision-1", DateTime.UtcNow.AddSeconds(1));
        var changedDraft = await service.SaveDraftAsync(
            store.Id,
            "publisher-a",
            changed,
            firstSha,
            "owner-a",
            CancellationToken.None);
        changedDraft.Status.ShouldBe(TutorialLinkGraphMutationStatus.Success);
        var secondSha = changedDraft.Graph!.Draft!.GraphSha256;
        secondSha.ShouldNotBe(firstSha);

        var stale = await service.PublishAsync(
            store.Id,
            "publisher-a",
            secondSha,
            new string('0', 64),
            "owner-a",
            CancellationToken.None);
        stale.Status.ShouldBe(TutorialLinkGraphMutationStatus.Stale);
        (await service.GetAsync(store.Id, "publisher-a", CancellationToken.None))!
            .Published!.GraphSha256.ShouldBe(firstSha);

        var secondPublished = await service.PublishAsync(
            store.Id,
            "publisher-a",
            secondSha,
            firstSha,
            "owner-a",
            CancellationToken.None);
        secondPublished.Status.ShouldBe(TutorialLinkGraphMutationStatus.Success);

        var rollback = await service.RollbackAsync(
            store.Id,
            "publisher-a",
            firstVersionId,
            secondSha,
            "owner-a",
            CancellationToken.None);
        rollback.Status.ShouldBe(TutorialLinkGraphMutationStatus.Success);
        rollback.Graph!.Published!.GraphSha256.ShouldBe(firstSha);
        rollback.Graph.Versions.Count.ShouldBe(3);
        rollback.Graph.Versions.Last().RolledBackFromVersionId.ShouldBe(firstVersionId);
    }

    [Fact]
    public async Task TutorialLinkGraph_RejectsMissingEvidenceMissingNodeAndOrphanTutorial()
    {
        await using var fixture = await PublisherMongoFixture.CreateAsync();
        var store = await fixture.InsertStoreAsync("owner-a");
        await fixture.Db.DocumentEntries.InsertManyAsync(new[]
        {
            ManagedDocument(store.Id, "tutorial-a", "chapter-00"),
            ManagedDocument(store.Id, "tutorial-b", "chapter-01"),
        });
        var service = new TutorialLinkGraphService(fixture.Db);

        var orphan = await service.SaveDraftAsync(
            store.Id,
            "publisher-a",
            Graph("revision-1", DateTime.UtcNow),
            null,
            "owner-a",
            CancellationToken.None);
        orphan.Status.ShouldBe(TutorialLinkGraphMutationStatus.Invalid);
        orphan.Message.ShouldNotBeNull();
        orphan.Message!.ShouldContain("没有页面反向链接");

        var missingEvidence = Graph("revision-1", DateTime.UtcNow);
        missingEvidence.Surfaces[0].TutorialSourceIds.Add("chapter-01");
        missingEvidence.Surfaces[0].TutorialLinks[0].EvidenceIds.Clear();
        var invalid = await service.SaveDraftAsync(
            store.Id,
            "publisher-a",
            missingEvidence,
            null,
            "owner-a",
            CancellationToken.None);
        invalid.Status.ShouldBe(TutorialLinkGraphMutationStatus.Invalid);
        invalid.Message.ShouldNotBeNull();
        invalid.Message!.ShouldContain("缺少验收证据");

        var missingNode = Graph("revision-1", DateTime.UtcNow);
        missingNode.Surfaces[0].TutorialSourceIds.Add("chapter-99");
        var missing = await service.SaveDraftAsync(
            store.Id,
            "publisher-a",
            missingNode,
            null,
            "owner-a",
            CancellationToken.None);
        missing.Status.ShouldBe(TutorialLinkGraphMutationStatus.Invalid);
        missing.Message.ShouldNotBeNull();
        missing.Message!.ShouldContain("不存在的教程节点");
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

    private static PublisherPutNodeRequest DocumentRequest(string runId, string title, string content)
        => new()
        {
            Publisher = "publisher-a",
            RunId = runId,
            Kind = "document",
            Title = title,
            SourcePath = "chapters/00-how-to-use.md",
            SourceSha256 = DocumentStorePublisherPolicy.Sha256(content),
            ManifestSha256 = DocumentStorePublisherPolicy.Sha256("manifest"),
            SourceRevision = "revision-1",
            ContentType = "text/markdown",
            Content = content,
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

    private static DocumentEntry ManagedDocument(string storeId, string id, string sourceId)
        => new()
        {
            Id = id,
            StoreId = storeId,
            IsFolder = false,
            Title = id,
            ContentType = "text/markdown",
            Metadata = DocumentStorePublisherPolicy.MergeMetadata(
                null,
                null,
                "publisher-a",
                sourceId,
                $"chapters/{sourceId}.md",
                EmptySha,
                DocumentStorePublisherPolicy.Sha256("manifest"),
                "revision-1",
                "document",
                "run-a",
                "run-a"),
        };

    private static TutorialLinkGraphRevision Graph(string sourceRevision, DateTime generatedAt)
        => new()
        {
            SchemaVersion = 2,
            SourceRevision = sourceRevision,
            ManifestSha256 = DocumentStorePublisherPolicy.Sha256("manifest"),
            VerifiedAtCommit = "0123456789abcdef",
            Generator = "llmgw-tutorial-publisher",
            GeneratedAt = generatedAt,
            Surfaces = new List<TutorialLinkSurface>
            {
                new()
                {
                    Id = "logs",
                    Routes = new List<string> { "/logs" },
                    PagePath = "llmgw/web/src/pages/LogsPage.tsx",
                    TutorialSourceIds = new List<string> { "chapter-00" },
                    TutorialLinks = new List<TutorialStepLink>
                    {
                        new()
                        {
                            SourceId = "chapter-00",
                            StepIds = new List<string> { "logs-table" },
                            EvidenceIds = new List<string> { "109-logs-table" },
                            Impact = new List<string> { "content", "screenshot" },
                        },
                    },
                },
            },
        };

    private sealed class PublisherMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;
        private readonly MemoryDocumentService _documents = new();

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
            var mentions = new MentionService(Db);
            var contentWriter = new EntryContentWriteService(
                Db,
                _documents,
                mentions,
                new DocumentVersionService(Db),
                NullLogger<EntryContentWriteService>.Instance);
            var controller = new DocumentStorePublisherController(
                Db,
                _documents,
                contentWriter,
                mentions);
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

        public Task ReplaceDocumentContentAsync(string documentId, string content)
            => _documents.ReplaceContentAsync(documentId, content);

        public async Task<string?> ReadDocumentContentAsync(string documentId)
            => (await _documents.GetByIdAsync(documentId))?.RawContent;

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }

    private sealed class MemoryDocumentService : IDocumentService
    {
        private readonly Dictionary<string, ParsedPrd> _documents = new(StringComparer.Ordinal);

        public Task<ParsedPrd> ParseAsync(string content)
        {
            var normalized = content.Replace("\r\n", "\n", StringComparison.Ordinal);
            return Task.FromResult(new ParsedPrd
            {
                Id = Sha256(normalized),
                RawContent = normalized,
                CharCount = normalized.Length,
            });
        }

        public Task<ParsedPrd?> GetByIdAsync(string documentId)
            => Task.FromResult(_documents.TryGetValue(documentId, out var document) ? Clone(document) : null);

        public Task<ParsedPrd> SaveAsync(ParsedPrd document)
        {
            _documents[document.Id] = Clone(document);
            return Task.FromResult(Clone(document));
        }

        public async Task<ParsedPrd?> UpdateTitleAsync(string documentId, string title)
        {
            var document = await GetByIdAsync(documentId);
            if (document == null) return null;
            document.Title = title;
            return await SaveAsync(document);
        }

        public int EstimateTokens(string content) => content.Length / 4;

        public async Task ReplaceContentAsync(string documentId, string content)
        {
            var document = await GetByIdAsync(documentId) ?? throw new InvalidOperationException("document missing");
            document.RawContent = content;
            await SaveAsync(document);
        }

        private static ParsedPrd Clone(ParsedPrd source)
            => new()
            {
                Id = source.Id,
                Title = source.Title,
                RawContent = source.RawContent,
                CharCount = source.CharCount,
                TokenEstimate = source.TokenEstimate,
                CreatedAt = source.CreatedAt,
            };

        private static string Sha256(string value)
            => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    }
}
