using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.DocumentStore;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class WritingAtomicPublicationTests
{
    [Fact]
    [Trait("Category", "Integration")]
    public async Task ConflictKeepsOldPublication_AndDerivedFailureKeepsCommittedBodyAndSnapshotTogether()
    {
        var connection = Environment.GetEnvironmentVariable("WRITING_TEST_MONGO") ?? "mongodb://127.0.0.1:27017";
        var name = "writing_atomic_" + Guid.NewGuid().ToString("N");
        var db = new MongoDbContext(connection, name);
        var client = new MongoClient(connection);
        try
        {
            var documents = new Dictionary<string, ParsedPrd> { ["old"] = new() { Id = "old", RawContent = "已发布v1", Title = "旧标题" } };
            var service = new Mock<IDocumentService>();
            service.Setup(s => s.ParseAsync(It.IsAny<string>())).ReturnsAsync((string content) => new ParsedPrd { Id = "next", RawContent = content });
            service.Setup(s => s.GetByIdAsync(It.IsAny<string>())).ReturnsAsync((string id) => documents.GetValueOrDefault(id));
            service.Setup(s => s.SaveAsync(It.IsAny<ParsedPrd>())).ReturnsAsync((ParsedPrd doc) => { documents[doc.Id] = doc; return doc; });
            var writer = new EntryContentWriteService(db, service.Object, new MentionService(db), new DocumentVersionService(db), NullLogger<EntryContentWriteService>.Instance);
            var at = DateTimeOffset.FromUnixTimeMilliseconds(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).UtcDateTime;
            var entry = new DocumentEntry { StoreId = "store", Title = "旧标题", DocumentId = "old", UpdatedAt = at,
                Writing = new() { Revision = 7, Stage = "publishing", Published = new() { Version = 1, Title = "旧标题" } } };
            await db.DocumentEntries.InsertOneAsync(entry);
            var nextState = new WritingDocumentState { Revision = 8, Stage = "published", Published = new() { Version = 2, Title = "新标题" } };
            var update = Builders<DocumentEntry>.Update.Set(e => e.Writing, nextState).Set(e => e.Title, "新标题");
            var conflict = await writer.WriteAsync(entry, new DocumentStore { Id = "store" }, "已发布v2", "author", "作者", DocumentVersionSource.Edit,
                expectedUpdatedAt: at, extraGuard: Builders<DocumentEntry>.Filter.Eq(e => e.Writing!.Revision, 999), atomicEntryUpdate: update);
            Assert.True(conflict.Conflicted);
            var old = await db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync();
            Assert.Equal("old", old.DocumentId); Assert.Equal(1, old.Writing!.Published!.Version);
            Assert.Equal("已发布v1", documents["old"].RawContent);

            // 故意拒绝版本历史写入：正文和发布快照已提交后的派生失败不得拆散它们。
            await db.Database.CreateCollectionAsync("document_entry_versions", new CreateCollectionOptions<BsonDocument> {
                Validator = new BsonDocument("_test_required", new BsonDocument("$exists", true))
            });
            var committed = await writer.WriteAsync(old, new DocumentStore { Id = "store" }, "已发布v2", "author", "作者", DocumentVersionSource.Edit,
                expectedUpdatedAt: at, derivedStateMetadataKey: "writing_derived_state",
                extraGuard: Builders<DocumentEntry>.Filter.Eq(e => e.Writing!.Revision, 7), atomicEntryUpdate: update);
            Assert.False(committed.Conflicted); Assert.True(committed.DerivedFailed);
            var actual = await db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync();
            Assert.Equal("next", actual.DocumentId); Assert.Equal(2, actual.Writing!.Published!.Version);
            Assert.Equal("新标题", actual.Title); Assert.Equal("已发布v2", documents[actual.DocumentId!].RawContent);
            Assert.Equal("已发布v1", documents["old"].RawContent);
        }
        finally { await client.DropDatabaseAsync(name); }
    }
}
